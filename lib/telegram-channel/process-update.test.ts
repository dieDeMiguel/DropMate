import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "experimental-ash/channels";

import type { AcceptReceptionRequestResult } from "../reception-request.js";

import {
  processInboundTelegramUpdate,
  type ClassifyGroupMessageResult,
  type DmIntentClassificationResult,
  type ProcessUpdateDeps,
  type TelegramChannelState,
  type TelegramSessionAuth,
} from "./process-update.js";
import type { Package, ReceptionRequest, Resident } from "../redis.js";
import type { RegisterPackageResult } from "../package.js";
import {
  PICKUP_ALREADY_DONE_ERROR_CODE,
  PICKUP_NOT_RECIPIENT_ERROR_CODE,
  type ConfirmPickupResult,
} from "../pickup.js";

const SECRET = "expected-secret";

function makeRequest(body: unknown, secretHeader: string | null = SECRET): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (secretHeader !== null) {
    headers.set("x-telegram-bot-api-secret-token", secretHeader);
  }
  return new Request("https://example.com/api/telegram", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Minimal Telegram update payload — a private text DM from a known user. */
function dmUpdate(opts: {
  chatId: number;
  text: string;
  fromUserId?: number;
  languageCode?: string;
}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      text: opts.text,
      chat: { id: opts.chatId, type: "private" },
      from: opts.fromUserId
        ? {
            id: opts.fromUserId,
            is_bot: false,
            first_name: "Test",
            language_code: opts.languageCode,
          }
        : undefined,
    },
  };
}

/** Build a fake Ash `Session` — only `.id` is read by the orchestrator. */
function makeSession(id: string): Session {
  return { id, continuationToken: "tg:1", async getEventStream() {
    return new ReadableStream();
  } } as unknown as Session;
}

interface BuiltDeps {
  deps: ProcessUpdateDeps;
  sendToAsh: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  drainSession: ReturnType<typeof vi.fn>;
  getFileUrl: ReturnType<typeof vi.fn>;
  parseTrackingPage: ReturnType<typeof vi.fn>;
  parseLabel: ReturnType<typeof vi.fn>;
  answerCallback: ReturnType<typeof vi.fn>;
  stripKeyboard: ReturnType<typeof vi.fn>;
  recordTelegramObservation: ReturnType<typeof vi.fn>;
  isRegisteredResident: ReturnType<typeof vi.fn>;
  classifyDmIntent: ReturnType<typeof vi.fn>;
  classifyGroupMessage: ReturnType<typeof vi.fn>;
  getRegisteredResident: ReturnType<typeof vi.fn>;
  createReceptionRequest: ReturnType<typeof vi.fn>;
  acceptReceptionRequest: ReturnType<typeof vi.fn>;
  registerPackage: ReturnType<typeof vi.fn>;
  resolveRecipient: ReturnType<typeof vi.fn>;
  confirmPickup: ReturnType<typeof vi.fn>;
  listOpenPackagesForRecipient: ReturnType<typeof vi.fn>;
  listMatchedReceptionRequestsForRequester: ReturnType<typeof vi.fn>;
  listMatchedReceptionRequestsForVolunteer: ReturnType<typeof vi.fn>;
  getResidentByPlatformId: ReturnType<typeof vi.fn>;
  editGroupCard: ReturnType<typeof vi.fn>;
  sendDirectMessage: ReturnType<typeof vi.fn>;
  registerResident: ReturnType<typeof vi.fn>;
  setTriggerAttribute: ReturnType<typeof vi.fn>;
}

type ParsedTrackingPage = NonNullable<
  Awaited<ReturnType<ProcessUpdateDeps["parseTrackingPage"]>>
>;
type ParsedLabel = Awaited<ReturnType<ProcessUpdateDeps["parseLabel"]>>;

function buildDeps(overrides: {
  session?: Session;
  expectedSecret?: string | undefined;
  fileUrl?: string;
  parsedTrackingPage?: ParsedTrackingPage | null;
  parsedLabel?: ParsedLabel;
  parsedLabelError?: Error;
  isRegisteredResident?: boolean;
  classification?: DmIntentClassificationResult;
  groupClassification?: ClassifyGroupMessageResult;
  groupClassificationError?: Error;
  registeredResident?: Resident | null;
  acceptResult?: AcceptReceptionRequestResult;
  registerResult?: { resident: Resident; updated: boolean };
  registerPackageResult?: RegisterPackageResult;
  registerPackageError?: Error;
  resolveRecipientResult?: Awaited<
    ReturnType<ProcessUpdateDeps["resolveRecipient"]>
  >;
  resolveRecipientError?: Error;
  confirmPickupResult?: ConfirmPickupResult;
  confirmPickupError?: Error;
  openPackagesForRecipient?: readonly Package[];
  openPackagesForRecipientError?: Error;
  matchedReceptionRequestsForRequester?: readonly ReceptionRequest[];
  matchedReceptionRequestsForRequesterError?: Error;
  matchedReceptionRequestsForVolunteer?: readonly ReceptionRequest[];
  matchedReceptionRequestsForVolunteerError?: Error;
  residentByPlatformId?: Resident | null;
  residentByPlatformIdError?: Error;
} = {}): BuiltDeps {
  const session = overrides.session ?? makeSession("sess_new");
  const sendToAsh = vi.fn().mockResolvedValue(session);
  const waitUntil = vi.fn();
  const drainSession = vi.fn().mockResolvedValue(undefined);
  const getFileUrl = vi
    .fn()
    .mockResolvedValue(
      overrides.fileUrl ??
        "https://api.telegram.org/file/bot111:AAA/photos/file_42.jpg",
    );
  const defaultParsedTrackingPage: ParsedTrackingPage = {
    carrier: "DHL",
    trackingNumber: "00340434161094021899",
    expectedWindowStartAt: "2026-05-19T13:00:00Z",
    expectedWindowEndAt: "2026-05-19T16:00:00Z",
    absenceSignal: true,
    confidence: "high",
    reason: "all fields legible",
  };
  const parseTrackingPage = vi
    .fn()
    .mockResolvedValue(
      "parsedTrackingPage" in overrides
        ? overrides.parsedTrackingPage
        : defaultParsedTrackingPage,
    );
  // v2.1 #107 Slice 2: default parse_label verdict is the Flow 1
  // happy path — a high-confidence parse with a registered Resident
  // recipient (matches the defaultRegisterPackageResult below).
  // Tests exercising the disambiguation cases override this.
  const defaultParsedLabel: ParsedLabel = {
    carrier: "DHL",
    trackingNumber: "00340434161094021899",
    recipientName: "Marlene Hartmann",
    recipientHouseNumber: "88",
    confidence: "high",
    reason: "all fields legible",
  };
  const parseLabel = overrides.parsedLabelError
    ? vi.fn().mockRejectedValue(overrides.parsedLabelError)
    : vi
        .fn()
        .mockResolvedValue(overrides.parsedLabel ?? defaultParsedLabel);
  const answerCallback = vi.fn().mockResolvedValue(undefined);
  const stripKeyboard = vi.fn().mockResolvedValue(undefined);
  const recordTelegramObservation = vi.fn().mockResolvedValue(undefined);
  const isRegisteredResident = vi
    .fn()
    .mockResolvedValue(
      "isRegisteredResident" in overrides
        ? Boolean(overrides.isRegisteredResident)
        : true,
    );
  // Default classifier verdict: not Flow 2. Tests that exercise the
  // routing override this explicitly. Default keeps the existing 30+
  // pre-v2.1 cases unchanged (they all hand raw text to the agent).
  //
  // v2.1 #110: `kind: "other"` replaces the pre-#110 `isFlow2: false`
  // shape. The discriminator's `pickup-confirmation` value is the new
  // value tested in the pickup-DM-text block below.
  const defaultClassification: DmIntentClassificationResult = {
    kind: "other",
    absenceSignal: false,
    confidence: "low",
    reason: "default test stub: not Flow 2",
  };
  const classifyDmIntent = vi
    .fn()
    .mockResolvedValue(overrides.classification ?? defaultClassification);

  // v2.1 #106: default group classifier verdict — not a package
  // registration. Tests exercising the Flow 1 route override this
  // with `groupClassification`. Group-text cases that pre-date #106
  // (off-topic chat, social posts) inherit the default and stay
  // silent (no agent invocation either) — that's the new structural
  // invariant the channel-deterministic path enforces.
  const defaultGroupClassification: ClassifyGroupMessageResult = {
    isPackageRegistration: false,
    recipients: [],
    confidence: "low",
    reason: "default test stub: not a package registration",
  };
  const classifyGroupMessage = overrides.groupClassificationError
    ? vi.fn().mockRejectedValue(overrides.groupClassificationError)
    : vi
        .fn()
        .mockResolvedValue(overrides.groupClassification ?? defaultGroupClassification);
  const defaultRegisterPackageResult: RegisterPackageResult = {
    package: {
      id: "pkg_test",
      streetId: "Methfesselstraße",
      recipientResidentId: "200",
      recipientName: "Marlene Hartmann",
      recipientHouseNumber: "88",
      holderResidentId: "100",
      carrier: "DHL",
      status: "held",
      receivedAt: Date.now(),
      pickedUpAt: null,
      reminded: false,
    } satisfies Package,
    holder: {
      id: "100",
      platformId: "100",
      name: "Diego de Miguel",
      houseNumber: "69",
      floor: "Erdgeschoss",
      buzzerName: null,
      language: "de",
    },
    recipientResolution: {
      kind: "resident",
      resident: {
        id: "200",
        name: "Marlene Hartmann",
        houseNumber: "88",
        language: "de",
        floor: null,
        buzzerName: null,
      },
    },
    receptionRequestFulfilled: null,
  };
  const registerPackage = overrides.registerPackageError
    ? vi.fn().mockRejectedValue(overrides.registerPackageError)
    : vi
        .fn()
        .mockResolvedValue(
          overrides.registerPackageResult ?? defaultRegisterPackageResult,
        );
  // v2.1 #109 (Slice 3 of #105): default resolveRecipient verdict —
  // "unknown" so any medium-conf classifier verdict that runs in
  // tests without an explicit override falls through (the safe
  // default that matches the "no Resident found" behaviour in
  // production). Tests exercising the medium-conf + resident branch
  // override this explicitly with `resolveRecipientResult`.
  const defaultResolveRecipientResult: Awaited<
    ReturnType<ProcessUpdateDeps["resolveRecipient"]>
  > = { kind: "unknown" };
  const resolveRecipient = overrides.resolveRecipientError
    ? vi.fn().mockRejectedValue(overrides.resolveRecipientError)
    : vi
        .fn()
        .mockResolvedValue(
          overrides.resolveRecipientResult ?? defaultResolveRecipientResult,
        );
  // v2.1 #108: default confirmPickup verdict — the recipient is
  // closing their own held package (the Flow 1 happy path). Tests
  // exercising the error branches override this with
  // `confirmPickupError`.
  const defaultConfirmPickupResult: ConfirmPickupResult = {
    package: {
      id: "pkg_42",
      streetId: "Methfesselstraße",
      recipientResidentId: "200",
      recipientName: "Marlene Hartmann",
      recipientHouseNumber: "88",
      holderResidentId: "100",
      carrier: "DHL",
      status: "picked_up",
      receivedAt: Date.now() - 60_000,
      pickedUpAt: Date.now(),
      reminded: false,
    } satisfies Package,
    holder: {
      id: "100",
      platformId: "100",
      name: "Diego de Miguel",
      houseNumber: "69",
      language: "de",
    },
    recipient: {
      id: "200",
      name: "Marlene Hartmann",
      houseNumber: "88",
      language: "de",
    },
  };
  const confirmPickup = overrides.confirmPickupError
    ? vi.fn().mockRejectedValue(overrides.confirmPickupError)
    : vi
        .fn()
        .mockResolvedValue(
          overrides.confirmPickupResult ?? defaultConfirmPickupResult,
        );
  // v2.1 #110: default to "no open packages" so the existing 30+ DM
  // text cases that don't exercise pickup-confirmation routing aren't
  // touched. Tests that exercise the pickup-DM-text path override
  // `openPackagesForRecipient` explicitly.
  const listOpenPackagesForRecipient = overrides.openPackagesForRecipientError
    ? vi.fn().mockRejectedValue(overrides.openPackagesForRecipientError)
    : vi
        .fn()
        .mockResolvedValue(overrides.openPackagesForRecipient ?? []);
  // v2.1 #122: default to "no matched RR as requester" so the existing
  // 0-package branch keeps sending the pre-#122 generic DM. Tests
  // exercising the new branch override this explicitly.
  const listMatchedReceptionRequestsForRequester =
    overrides.matchedReceptionRequestsForRequesterError
      ? vi
          .fn()
          .mockRejectedValue(
            overrides.matchedReceptionRequestsForRequesterError,
          )
      : vi
          .fn()
          .mockResolvedValue(
            overrides.matchedReceptionRequestsForRequester ?? [],
          );
  // v2.1 #121: default to "no matched RR as volunteer" so the existing
  // suite is untouched. Tests exercising the
  // flow2-volunteer-early-arrival path override this explicitly.
  const listMatchedReceptionRequestsForVolunteer =
    overrides.matchedReceptionRequestsForVolunteerError
      ? vi
          .fn()
          .mockRejectedValue(
            overrides.matchedReceptionRequestsForVolunteerError,
          )
      : vi
          .fn()
          .mockResolvedValue(
            overrides.matchedReceptionRequestsForVolunteer ?? [],
          );
  const getResidentByPlatformId = overrides.residentByPlatformIdError
    ? vi.fn().mockRejectedValue(overrides.residentByPlatformIdError)
    : vi
        .fn()
        .mockResolvedValue(
          "residentByPlatformId" in overrides
            ? overrides.residentByPlatformId
            : null,
        );
  const getRegisteredResident = vi
    .fn()
    .mockResolvedValue(
      "registeredResident" in overrides ? overrides.registeredResident : null,
    );
  const createReceptionRequest = vi.fn().mockResolvedValue({
    request: {
      id: "req_test",
      streetId: "Methfesselstraße",
      requesterResidentId: "patricia",
      requesterName: "Patricia",
      requesterHouseNumber: "90",
      carrier: "unknown",
      expectedAt: null,
      volunteerResidentId: null,
      volunteerAvailability: null,
      status: "open",
      createdAt: Date.now(),
      respondedAt: null,
    },
    groupCard: { chatId: -100123, messageId: 42 },
  });
  const defaultAcceptResult: AcceptReceptionRequestResult = {
    request: {
      id: "req_42",
      streetId: "Methfesselstraße",
      requesterResidentId: "200",
      requesterName: "Patricia Höfer",
      requesterHouseNumber: "90",
      carrier: "DHL",
      expectedAt: null,
      volunteerResidentId: "300",
      volunteerAvailability: null,
      status: "matched",
      createdAt: Date.now(),
      respondedAt: Date.now(),
      expectedWindowStartAt: 1716122400000,
      expectedWindowEndAt: 1716133200000,
      groupCardChatId: -100123,
      groupCardMessageId: 555,
    } satisfies ReceptionRequest,
    requester: {
      id: "200",
      name: "Patricia Höfer",
      houseNumber: "90",
      language: "de",
      floor: "II.",
      buzzerName: "Höfer",
    },
    volunteer: {
      id: "300",
      name: "Marlene Hartmann",
      houseNumber: "88",
      language: "de",
      floor: "V.",
      buzzerName: "Hartmann",
      platformId: "300",
    },
    groupCardChatId: -100123,
    groupCardMessageId: 555,
  };
  const acceptReceptionRequest = vi
    .fn()
    .mockResolvedValue(overrides.acceptResult ?? defaultAcceptResult);
  const editGroupCard = vi.fn().mockResolvedValue(undefined);
  const sendDirectMessage = vi.fn().mockResolvedValue(undefined);
  const defaultRegisterResult = {
    resident: {
      id: "12345",
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      floor: "Erdgeschoss Links",
      platformId: "12345",
      platform: "telegram" as const,
      language: "de",
      availabilityPatterns: [],
      registeredAt: 1716000000000,
      source: "explicit" as const,
      confirmed: true,
    } satisfies Resident,
    updated: false,
  };
  const registerResident = vi
    .fn()
    .mockResolvedValue(overrides.registerResult ?? defaultRegisterResult);
  const setTriggerAttribute = vi.fn();
  return {
    sendToAsh,
    waitUntil,
    drainSession,
    getFileUrl,
    parseTrackingPage,
    parseLabel,
    answerCallback,
    stripKeyboard,
    recordTelegramObservation,
    isRegisteredResident,
    classifyDmIntent,
    classifyGroupMessage,
    getRegisteredResident,
    createReceptionRequest,
    acceptReceptionRequest,
    registerPackage,
    resolveRecipient,
    confirmPickup,
    listOpenPackagesForRecipient,
    listMatchedReceptionRequestsForRequester,
    listMatchedReceptionRequestsForVolunteer,
    getResidentByPlatformId,
    editGroupCard,
    sendDirectMessage,
    registerResident,
    setTriggerAttribute,
    deps: {
      expectedSecret:
        "expectedSecret" in overrides ? overrides.expectedSecret : SECRET,
      sendToAsh: sendToAsh as ProcessUpdateDeps["sendToAsh"],
      waitUntil,
      drainSession,
      getFileUrl,
      parseTrackingPage,
      parseLabel,
      answerCallback,
      stripKeyboard,
      recordTelegramObservation,
      isRegisteredResident,
      classifyDmIntent,
      classifyGroupMessage,
      getRegisteredResident,
      createReceptionRequest,
      acceptReceptionRequest,
      registerPackage,
      resolveRecipient,
      confirmPickup,
      listOpenPackagesForRecipient,
      listMatchedReceptionRequestsForRequester,
      listMatchedReceptionRequestsForVolunteer,
      getResidentByPlatformId,
      editGroupCard,
      sendDirectMessage,
      registerResident,
      setTriggerAttribute,
    },
  };
}

describe("processInboundTelegramUpdate", () => {
  it("returns 401 when the secret-token header is wrong", async () => {
    const { deps } = buildDeps();
    const res = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 1, text: "hi" }), "wrong"),
      deps,
    );
    expect(res.status).toBe(401);
  });

  it("returns 500 when the expected secret is unset (server misconfig)", async () => {
    const { deps } = buildDeps({ expectedSecret: undefined });
    const res = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 1, text: "hi" })),
      deps,
    );
    expect(res.status).toBe(500);
  });

  it("returns 400 on malformed JSON", async () => {
    const { deps, sendToAsh } = buildDeps();
    const res = await processInboundTelegramUpdate(
      makeRequest("not json {{{"),
      deps,
    );
    expect(res.status).toBe(400);
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("returns 204 without sending for updates that have no text message", async () => {
    const { deps, sendToAsh, waitUntil } = buildDeps();
    // No `message.text` → extractInboundMessage returns null.
    const res = await processInboundTelegramUpdate(
      makeRequest({ update_id: 7, edited_message: { message_id: 1 } }),
      deps,
    );
    expect(res.status).toBe(204);
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("drives the agent with the stable tg:<chatId> continuation token and backgrounds the drain", async () => {
    const session = makeSession("sess_abc");
    const { deps, sendToAsh, waitUntil, drainSession } = buildDeps({ session });

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "Hallo", fromUserId: 99, languageCode: "de" }),
      ),
      deps,
    );

    expect(res.status).toBe(204);

    expect(sendToAsh).toHaveBeenCalledTimes(1);
    const [text, options] = sendToAsh.mock.calls[0]!;
    expect(text).toBe("Hallo");
    expect(options.continuationToken).toBe("tg:42");
    expect(options.auth).toEqual<TelegramSessionAuth>({
      principalId: "99",
      principalType: "user",
      authenticator: "telegram",
      attributes: { languageCode: "de" },
    });
    expect(options.state).toEqual<TelegramChannelState>({
      chatId: 42,
      isGroup: false,
      fromUserId: 99,
      fromLanguageCode: "de",
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The backgrounded task is the drain — invoking it should not throw.
    await waitUntil.mock.calls[0]![0];
    expect(drainSession).toHaveBeenCalledWith(session, 42);
  });

  it("uses tg:<chatId> as the continuation token on every turn (no per-run id reuse — #65)", async () => {
    // Regression test for #65: previously the orchestrator stored the
    // returned session.id (a per-run wrun_… id) and reused it next turn,
    // which caused Ash to log "deliver failed, starting new session"
    // and spawn a fresh, context-free session on every webhook. The fix
    // is to use the stable chat-keyed token unconditionally.
    const session = makeSession("wrun_01KRZEH9RHK4EPTWZ6BDGGTSVQ");
    const { deps, sendToAsh } = buildDeps({ session });

    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 7, text: "follow-up", fromUserId: 99 })),
      deps,
    );

    const options = sendToAsh.mock.calls[0]![1];
    expect(options.continuationToken).toBe("tg:7");
    // No per-run id leaks into the continuation token.
    expect(options.continuationToken).not.toMatch(/^wrun_/);
  });

  it("omits auth when the inbound message has no sender", async () => {
    const { deps, sendToAsh } = buildDeps();

    await processInboundTelegramUpdate(
      // No `from` field → fromUserId is null.
      makeRequest(dmUpdate({ chatId: 5, text: "anon" })),
      deps,
    );

    const options = sendToAsh.mock.calls[0]![1];
    expect(options.auth).toBeNull();
    expect(options.state.fromUserId).toBeNull();
  });

  it("leaves auth.attributes empty when Telegram does not supply a language code", async () => {
    const { deps, sendToAsh } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 5, text: "hi", fromUserId: 99 })),
      deps,
    );

    const options = sendToAsh.mock.calls[0]![1];
    expect(options.auth).toEqual<TelegramSessionAuth>({
      principalId: "99",
      principalType: "user",
      authenticator: "telegram",
      attributes: {},
    });
  });

  describe("group photo → channel-deterministic Flow 1 (v2.1 #107 Slice 2 of #106)", () => {
    // v2.1 #107 / Slice 2 of #106: group photos no longer reach the
    // agent on the happy path. The channel resolves the file URL,
    // calls parse_label itself, and on a high-confidence parse with a
    // registered-resident recipient posts the deterministic group ack
    // + recipient DM via lib/telegram-channel/flow-1-dms.ts. Closes
    // the agent text-leak surface the live trace 2026-05-22 produced
    // (#105 — 20+ free-form German messages on a single inbound).

    function holderResident(): Resident {
      return {
        id: "100",
        name: "Diego Demiguel",
        street: "Lutterothstrasse",
        houseNumber: "69",
        platformId: "100",
        platform: "telegram",
        language: "de",
        availabilityPatterns: [],
        registeredAt: Date.now(),
        source: "explicit",
        confirmed: true,
      };
    }

    function groupPhotoUpdate(opts: {
      caption?: string;
      photoFileIds?: ReadonlyArray<string>;
      chatId?: number;
      fromUserId?: number;
      languageCode?: string;
    } = {}): Record<string, unknown> {
      const fromUserId = opts.fromUserId ?? 100;
      return {
        update_id: 500,
        message: {
          message_id: 1,
          date: 1,
          ...(opts.caption ? { caption: opts.caption } : {}),
          chat: { id: opts.chatId ?? -100, type: "supergroup" },
          from: {
            id: fromUserId,
            is_bot: false,
            first_name: "Holder",
            language_code: opts.languageCode ?? "de",
          },
          photo: (opts.photoFileIds ?? ["only"]).map((file_id) => ({
            file_id,
            file_size: 100,
            width: 90,
            height: 90,
          })),
        },
      };
    }

    it("on high-confidence parse + registered-resident recipient: calls parseLabel + registerPackage + posts announce-only group ack + DMs recipient with [Abgeholt] keyboard (v2.1 #114: no group keyboard), no agent invocation", async () => {
      const fileUrl =
        "https://api.telegram.org/file/bot111:AAA/photos/file_99.jpg";
      const {
        deps,
        sendToAsh,
        getFileUrl,
        parseLabel,
        parseTrackingPage,
        registerPackage,
        sendDirectMessage,
      } = buildDeps({
        fileUrl,
        registeredResident: holderResident(),
      });

      const res = await processInboundTelegramUpdate(
        makeRequest(
          groupPhotoUpdate({
            caption: "Paket für Marlene",
            photoFileIds: ["small", "large"],
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);

      // The orchestrator picks the largest photo size (last entry).
      expect(getFileUrl).toHaveBeenCalledWith("large");

      // parseLabel is invoked channel-side now (not the agent).
      // parseTrackingPage is the DM-photo branch; never fires here.
      expect(parseLabel).toHaveBeenCalledTimes(1);
      expect(parseLabel).toHaveBeenCalledWith({
        imageUrl: fileUrl,
        caption: "Paket für Marlene",
      });
      expect(parseTrackingPage).not.toHaveBeenCalled();

      expect(registerPackage).toHaveBeenCalledTimes(1);
      // Two sendDirectMessage calls: one to the group (announce-only),
      // one to the recipient (carries the [Abgeholt] keyboard).
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
      // Agent is NEVER invoked on this path.
      expect(sendToAsh).not.toHaveBeenCalled();

      // Group ack: posted to the inbound chat id (the group). v2.1
      // #114 regression pin: NO inline keyboard on the group ack.
      const [groupChatId, groupText, groupEntities, groupKeyboard] =
        sendDirectMessage.mock.calls[0]!;
      expect(groupChatId).toBe(-100);
      expect(groupText).toContain("📦 Paket von Diego de Miguel (69)");
      expect(groupText).toContain("an Marlene Hartmann (88)");
      expect(groupEntities).toBeUndefined();
      expect(groupKeyboard).toBeUndefined();

      // Recipient DM: sent to the recipient's chat id (numeric of the
      // platformId), carries the pickup keyboard (the only surface
      // that does post-#114).
      const [recipientChatId, recipientText, _recipientEntities, recipientKeyboard] =
        sendDirectMessage.mock.calls[1]!;
      expect(recipientChatId).toBe(200);
      expect(recipientText).toContain("Hi Marlene Hartmann!");
      expect(recipientText).toContain("Diego de Miguel hat ein Paket");
      expect(recipientText).toContain("[Abgeholt]");
      expect(recipientKeyboard).toBeDefined();
      expect(
        (recipientKeyboard as { inline_keyboard: ReadonlyArray<unknown> })
          .inline_keyboard,
      ).toHaveLength(1);
    });

    it("v2.1 #116 — on Flow 2 fulfillment linkage (receptionRequestFulfilled !== null): suppresses the group ack, DMs the holder a private confirmation, still DMs the recipient with the [Abgeholt] keyboard", async () => {
      const {
        deps,
        sendToAsh,
        registerPackage,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: holderResident(),
        registerPackageResult: {
          package: {
            id: "pkg_linked",
            streetId: "Methfesselstraße",
            recipientResidentId: "200",
            recipientName: "Patricia Höfer",
            recipientHouseNumber: "90",
            holderResidentId: "100",
            carrier: "DHL",
            status: "held",
            receivedAt: Date.now(),
            pickedUpAt: null,
            reminded: false,
            receptionRequestId: "req_matched",
          } satisfies Package,
          holder: {
            id: "100",
            platformId: "100",
            name: "Diego de Miguel",
            houseNumber: "69",
            floor: null,
            buzzerName: null,
            language: "de",
          },
          recipientResolution: {
            kind: "resident",
            resident: {
              id: "200",
              name: "Patricia Höfer",
              houseNumber: "90",
              language: "de",
              floor: null,
              buzzerName: null,
            },
          },
          receptionRequestFulfilled: {
            requestId: "req_matched",
            requesterResidentId: "200",
            previousStatus: "matched",
          },
        },
      });

      const res = await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "Paket für Patricia" })),
        deps,
      );

      expect(res.status).toBe(204);
      expect(registerPackage).toHaveBeenCalledTimes(1);
      // Two DMs: one private holder confirmation, one recipient DM.
      // NO group ack on this branch.
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
      expect(sendToAsh).not.toHaveBeenCalled();

      // First DM is the holder confirmation — sent to holder.platformId
      // (Number(100) === 100), NOT to the group chat id (-100).
      const [holderChatId, holderText, holderEntities, holderKeyboard] =
        sendDirectMessage.mock.calls[0]!;
      expect(holderChatId).toBe(100);
      expect(holderChatId).not.toBe(-100);
      expect(holderText).toContain("Paket für Patricia Höfer erkannt");
      expect(holderText).toContain("Patricia Höfer wurde benachrichtigt");
      expect(holderEntities).toBeUndefined();
      expect(holderKeyboard).toBeUndefined();

      // Regression pin: the group chat (chatId -100) is NEVER addressed
      // by sendDirectMessage on the suppression branch.
      for (const call of sendDirectMessage.mock.calls) {
        expect(call[0]).not.toBe(-100);
      }

      // Second DM is the recipient DM — same shape as the
      // non-suppressed path, with the [Abgeholt] keyboard.
      const [recipientChatId, recipientText, , recipientKeyboard] =
        sendDirectMessage.mock.calls[1]!;
      expect(recipientChatId).toBe(200);
      expect(recipientText).toContain("Hi Patricia Höfer!");
      expect(recipientText).toContain("[Abgeholt]");
      expect(recipientKeyboard).toBeDefined();
    });

    it("v2.1 #116 — also suppresses when previousStatus='open' (no volunteer accepted yet, but holder showed up anyway)", async () => {
      const {
        deps,
        registerPackage,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: holderResident(),
        registerPackageResult: {
          package: {
            id: "pkg_linked",
            streetId: "Methfesselstraße",
            recipientResidentId: "200",
            recipientName: "Patricia",
            recipientHouseNumber: "90",
            holderResidentId: "100",
            carrier: "DHL",
            status: "held",
            receivedAt: Date.now(),
            pickedUpAt: null,
            reminded: false,
            receptionRequestId: "req_open",
          } satisfies Package,
          holder: {
            id: "100",
            platformId: "100",
            name: "Diego de Miguel",
            houseNumber: "69",
            floor: null,
            buzzerName: null,
            language: "de",
          },
          recipientResolution: {
            kind: "resident",
            resident: {
              id: "200",
              name: "Patricia",
              houseNumber: "90",
              language: "de",
              floor: null,
              buzzerName: null,
            },
          },
          receptionRequestFulfilled: {
            requestId: "req_open",
            requesterResidentId: "200",
            previousStatus: "open",
          },
        },
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "Paket für Patricia" })),
        deps,
      );

      expect(registerPackage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
      // No group chat call.
      for (const call of sendDirectMessage.mock.calls) {
        expect(call[0]).not.toBe(-100);
      }
    });

    it("forwards the caption (or undefined when absent) to parseLabel", async () => {
      // No caption → parseLabel called with `caption: undefined`.
      const { deps, parseLabel } = buildDeps({
        registeredResident: holderResident(),
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({})),
        deps,
      );

      expect(parseLabel).toHaveBeenCalledTimes(1);
      expect(parseLabel.mock.calls[0]![0]).toMatchObject({
        caption: undefined,
      });
    });

    it("hands the agent a [FLOW_1 CLARIFICATION reason=low-conf] synthetic when parseLabel returns low confidence (v2.1 #109 Slice 3 of #105)", async () => {
      const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
        registeredResident: holderResident(),
        parsedLabel: {
          carrier: "DHL",
          recipientName: "Foo",
          recipientHouseNumber: "12",
          confidence: "low",
          reason: "blurry label",
        },
      });

      const res = await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "kann das jemand lesen?" })),
        deps,
      );

      expect(res.status).toBe(204);
      // No Package write on the fallthrough path — the agent asks the
      // holder to clarify; the holder's restated reply gets a fresh
      // classification run.
      expect(registerPackage).not.toHaveBeenCalled();
      // No group post / DM on fallthrough either.
      expect(sendDirectMessage).not.toHaveBeenCalled();
      // The agent IS invoked with the clarification synthetic.
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [syntheticMessage] = sendToAsh.mock.calls[0]!;
      expect(syntheticMessage).toContain("[FLOW_1 CLARIFICATION");
      expect(syntheticMessage).toContain("reason=low-conf");
      expect(syntheticMessage).toContain("Do NOT call any tools");
    });

    it("hands the agent reason=ambiguous-multi when the caption clearly names 2+ recipients at low confidence", async () => {
      const { deps, sendToAsh, registerPackage } = buildDeps({
        registeredResident: holderResident(),
        parsedLabel: {
          carrier: "DHL",
          recipientName: "Foo",
          confidence: "low",
          reason: "label only shows one name; caption suggests two",
        },
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "Paket für Anna und Beate" })),
        deps,
      );

      expect(registerPackage).not.toHaveBeenCalled();
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [syntheticMessage] = sendToAsh.mock.calls[0]!;
      expect(syntheticMessage).toContain("reason=ambiguous-multi");
    });

    it("on medium-conf + recipient resolves to a Resident: registers deterministically (treats medium as high when the second signal converges, v2.1 #109)", async () => {
      const {
        deps,
        sendToAsh,
        parseLabel,
        resolveRecipient,
        registerPackage,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: holderResident(),
        parsedLabel: {
          carrier: "Hermes",
          recipientName: "Foo",
          confidence: "medium",
          reason: "partial label, name legible",
        },
        // resolveRecipient finds the recipient as a registered Resident
        resolveRecipientResult: {
          kind: "resident",
          resident: {
            id: "200",
            name: "Foo",
            houseNumber: "88",
            language: "de",
            floor: null,
            buzzerName: null,
          },
        },
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "Paket für Foo" })),
        deps,
      );

      // Resolve first, then register.
      expect(parseLabel).toHaveBeenCalledTimes(1);
      expect(resolveRecipient).toHaveBeenCalledTimes(1);
      expect(registerPackage).toHaveBeenCalledTimes(1);
      // Group ack + recipient DM, no agent invocation.
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("on medium-conf + recipient does NOT resolve to a Resident: falls through to clarification synthetic, NO Package write (v2.1 #109)", async () => {
      const {
        deps,
        sendToAsh,
        resolveRecipient,
        registerPackage,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: holderResident(),
        parsedLabel: {
          carrier: "Hermes",
          recipientName: "Stranger",
          confidence: "medium",
          reason: "partial label",
        },
        // Default resolveRecipient returns unknown — explicit for clarity.
        resolveRecipientResult: { kind: "unknown" },
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "Paket für Stranger" })),
        deps,
      );

      expect(resolveRecipient).toHaveBeenCalledTimes(1);
      // No Package write — clarification first.
      expect(registerPackage).not.toHaveBeenCalled();
      // No group / DM post.
      expect(sendDirectMessage).not.toHaveBeenCalled();
      // Clarification synthetic to the agent.
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [synthetic] = sendToAsh.mock.calls[0]!;
      expect(synthetic).toContain("reason=low-conf");
    });

    it("hands the agent reason=missing-recipient when parseLabel omits recipientName even at high confidence (v2.1 #109)", async () => {
      const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
        registeredResident: holderResident(),
        parsedLabel: {
          carrier: "DHL",
          // recipientName intentionally omitted
          confidence: "high",
          reason: "carrier legible, name not",
        },
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "DHL label" })),
        deps,
      );

      expect(registerPackage).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [synthetic] = sendToAsh.mock.calls[0]!;
      expect(synthetic).toContain("reason=missing-recipient");
    });

    it("hands the agent reason=parse-failed when parseLabel throws (vision outage, both primary + fallback errored) (v2.1 #109)", async () => {
      const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
        registeredResident: holderResident(),
        parsedLabelError: new Error("vision outage"),
      });

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "Paket für jemand" })),
        deps,
      );

      expect(registerPackage).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [synthetic] = sendToAsh.mock.calls[0]!;
      expect(synthetic).toContain("reason=parse-failed");
    });

    it("hands the agent reason=parse-failed when getFileUrl throws (cannot resolve the photo to a URL) (v2.1 #109)", async () => {
      const {
        deps,
        sendToAsh,
        getFileUrl,
        parseLabel,
        registerPackage,
      } = buildDeps({
        registeredResident: holderResident(),
      });
      getFileUrl.mockRejectedValueOnce(new Error("Bot API 404"));

      await processInboundTelegramUpdate(
        makeRequest(groupPhotoUpdate({ caption: "kann das jemand lesen?" })),
        deps,
      );

      // parse_label never runs without a URL.
      expect(parseLabel).not.toHaveBeenCalled();
      expect(registerPackage).not.toHaveBeenCalled();
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [synthetic] = sendToAsh.mock.calls[0]!;
      expect(synthetic).toContain("reason=parse-failed");
    });

    it("DMs the unregistered holder a /register nudge when registerPackage throws REGISTER_PACKAGE_HOLDER_NOT_REGISTERED — silent in the group", async () => {
      const error = Object.assign(new Error("not registered"), {
        code: "REGISTER_PACKAGE_HOLDER_NOT_REGISTERED",
      });
      const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
        registeredResident: null, // holder not registered
        registerPackageError: error,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          groupPhotoUpdate({
            caption: "Paket für Marlene",
            fromUserId: 999,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(registerPackage).toHaveBeenCalledTimes(1);
      // ONE DM goes out — the localised /register nudge to the holder.
      // Group stays silent (no group ack on this branch).
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      const [nudgeChatId, nudgeText] = sendDirectMessage.mock.calls[0]!;
      expect(nudgeChatId).toBe(999);
      expect(nudgeText).toContain("/register");
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("on high-conf + recipient resolution 'unknown': posts the deterministic group question (📦 Paket für X – kennt jemand X?), no agent invocation (v2.1 #109)", async () => {
      const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
        registeredResident: holderResident(),
        parsedLabel: {
          carrier: "DHL",
          recipientName: "Stranger",
          recipientHouseNumber: "999",
          confidence: "high",
          reason: "ok",
        },
        registerPackageResult: {
          package: {
            id: "pkg_unknown",
            streetId: "Lutterothstrasse",
            recipientResidentId: null,
            recipientName: "Stranger",
            recipientHouseNumber: "999",
            holderResidentId: "100",
            carrier: "DHL",
            status: "held",
            receivedAt: Date.now(),
            pickedUpAt: null,
            reminded: false,
          } satisfies Package,
          holder: {
            id: "100",
            platformId: "100",
            name: "Diego Demiguel",
            houseNumber: "69",
            floor: null,
            buzzerName: null,
            language: "de",
          },
          recipientResolution: { kind: "unknown" },
          receptionRequestFulfilled: null,
        },
      });

      await processInboundTelegramUpdate(
        makeRequest(
          groupPhotoUpdate({ caption: "Paket für Stranger (Hs.999)" }),
        ),
        deps,
      );

      // Package is still registered (the cron sweep ages it out if
      // nobody claims), AND the group question is posted.
      expect(registerPackage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      const [chatId, text] = sendDirectMessage.mock.calls[0]!;
      expect(chatId).toBe(-100);
      expect(text).toBe("📦 Paket für Stranger – kennt jemand Stranger?");
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("anonymous group photo (no fromUserId) stays silent — parseLabel is not even called", async () => {
      const { deps, sendToAsh, parseLabel, sendDirectMessage } = buildDeps();

      await processInboundTelegramUpdate(
        makeRequest({
          update_id: 600,
          message: {
            message_id: 1,
            date: 1,
            caption: "Paket für jemanden",
            chat: { id: -100, type: "supergroup" },
            // No `from` — anonymous group post.
            photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
          },
        }),
        deps,
      );

      expect(parseLabel).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });
  });

  describe("DM photo → parseTrackingPage → channel-side Flow 2 routing (v2.1 Slice 3, #88)", () => {
    function dmRegisteredResident(language: string | undefined = "de"): Resident {
      return {
        id: "patricia",
        name: "Patricia Höfer",
        street: "Methfesselstraße",
        houseNumber: "90",
        platformId: "patricia",
        platform: "telegram",
        language,
        availabilityPatterns: [],
        registeredAt: Date.now(),
        source: "explicit",
        confirmed: true,
      };
    }

    function dmPhotoUpdate(opts: {
      updateId?: number;
      chatId?: number;
      fromUserId?: number;
      languageCode?: string;
      caption?: string;
      photoFileIds?: ReadonlyArray<string>;
    } = {}): Record<string, unknown> {
      return {
        update_id: opts.updateId ?? 200,
        message: {
          message_id: 1,
          date: 1,
          ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
          chat: { id: opts.chatId ?? 42, type: "private" },
          ...(opts.fromUserId !== undefined
            ? {
                from: {
                  id: opts.fromUserId,
                  is_bot: false,
                  first_name: "T",
                  language_code: opts.languageCode,
                },
              }
            : {}),
          photo: (opts.photoFileIds ?? ["only"]).map((file_id) => ({
            file_id,
            file_size: 1024,
            width: 1024,
            height: 1024,
          })),
        },
      };
    }

    // v2.1 #100: the DM photo path is now fully channel-deterministic.
    // On every outcome (success ack OR vision-low-confidence recovery)
    // the channel sends ONE localised DM via sendDirectMessage and does
    // NOT invoke the agent. The agent text-leak surface that produced
    // the welcome wall + duplicate registration confirmation + tripled
    // ack on the live trace is closed structurally.

    it("on high-confidence + absenceSignal:true + registered caller, writes a ReceptionRequest and sends the German ack DM (no agent invocation)", async () => {
      const fileUrl =
        "https://api.telegram.org/file/bot111:AAA/photos/file_77.jpg";
      const resident = dmRegisteredResident("de");
      const {
        deps,
        sendToAsh,
        sendDirectMessage,
        waitUntil,
        getFileUrl,
        parseTrackingPage,
        createReceptionRequest,
        getRegisteredResident,
      } = buildDeps({
        fileUrl,
        parsedTrackingPage: {
          carrier: "DHL",
          trackingNumber: "00340434161094021899",
          expectedWindowStartAt: "2026-05-19T13:00:00Z",
          expectedWindowEndAt: "2026-05-19T16:00:00Z",
          absenceSignal: true,
          confidence: "high",
          reason: "all fields legible",
        },
        registeredResident: resident,
      });

      const res = await processInboundTelegramUpdate(
        makeRequest(
          dmPhotoUpdate({
            caption: "kann jemand annehmen? bin nicht da",
            fromUserId: 99,
            languageCode: "de",
            photoFileIds: ["small", "large"],
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(getFileUrl).toHaveBeenCalledWith("large");

      expect(parseTrackingPage).toHaveBeenCalledTimes(1);
      const parseArgs = parseTrackingPage.mock.calls[0]![0];
      expect(parseArgs.imageUrl).toBe(fileUrl);
      expect(parseArgs.caption).toBe("kann jemand annehmen? bin nicht da");

      // Channel writes the ReceptionRequest deterministically.
      expect(getRegisteredResident).toHaveBeenCalledWith(99);
      expect(createReceptionRequest).toHaveBeenCalledTimes(1);
      const [caller, input] = createReceptionRequest.mock.calls[0]!;
      expect(caller).toBe(resident);
      expect(input.carrier).toBe("DHL");
      expect(input.expectedWindowStartAt).toBe(
        Date.parse("2026-05-19T13:00:00Z"),
      );
      expect(input.expectedWindowEndAt).toBe(
        Date.parse("2026-05-19T16:00:00Z"),
      );

      // #100: agent NEVER runs on the DM photo success path. Channel
      // sent the deterministic ack DM in the requester's language.
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      const [chatId, text] = sendDirectMessage.mock.calls[0]!;
      expect(chatId).toBe(42);
      expect(text).toBe(
        "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
      );
    });

    it("treats absenceSignal:undefined as implicit absence (uploading a tracking page in DM is itself the absence signal)", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
        buildDeps({
          parsedTrackingPage: {
            carrier: "Hermes",
            confidence: "high",
            reason: "clean tracking page, empty caption",
          },
          registeredResident: resident,
        });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(createReceptionRequest).toHaveBeenCalledTimes(1);
      const [, input] = createReceptionRequest.mock.calls[0]!;
      expect(input.carrier).toBe("Hermes");
      expect(input.expectedWindowStartAt).toBeUndefined();
      expect(input.expectedWindowEndAt).toBeUndefined();

      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
      );
    });

    it("on absenceSignal:false (explicit non-absence — search intent), sends the German recovery DM and does NOT post the card", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
        buildDeps({
          parsedTrackingPage: {
            carrier: "DHL",
            trackingNumber: "00340434161094021899",
            expectedWindowStartAt: "2026-05-19T13:00:00Z",
            expectedWindowEndAt: "2026-05-19T16:00:00Z",
            absenceSignal: false,
            confidence: "high",
            reason: "tracking page legible but caption is a search query",
          },
          registeredResident: resident,
        });

      await processInboundTelegramUpdate(
        makeRequest(
          dmPhotoUpdate({
            caption: "wo ist mein Paket?",
            fromUserId: 99,
            languageCode: "de",
          }),
        ),
        deps,
      );

      // Critical privacy guarantee: no card posted when the caption
      // explicitly disclaims absence.
      expect(createReceptionRequest).not.toHaveBeenCalled();
      // #100: agent never runs on the recovery path either.
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      const [, text] = sendDirectMessage.mock.calls[0]!;
      expect(text).toContain("Ich konnte den Beleg nicht eindeutig lesen");
      expect(text).toContain("/receive");
    });

    it("on confidence:low, sends the German recovery DM and does NOT post the card", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
        buildDeps({
          parsedTrackingPage: {
            carrier: "unknown",
            confidence: "low",
            reason: "carrier logo cropped",
          },
          registeredResident: resident,
        });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("on confidence:medium (not high), sends the German recovery DM and does NOT post the card", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
        buildDeps({
          parsedTrackingPage: {
            carrier: "DHL",
            absenceSignal: true,
            confidence: "medium",
            reason: "carrier legible but window obscured",
          },
          registeredResident: resident,
        });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("on parseTrackingPage returning null, sends the German recovery DM", async () => {
      const {
        deps,
        sendToAsh,
        sendDirectMessage,
        parseTrackingPage,
        createReceptionRequest,
      } = buildDeps({ parsedTrackingPage: null });

      await processInboundTelegramUpdate(
        makeRequest(
          dmPhotoUpdate({
            caption: "kannst du das lesen?",
            fromUserId: 99,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(parseTrackingPage).toHaveBeenCalledTimes(1);
      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("on parseTrackingPage throwing, sends the German recovery DM", async () => {
      const {
        deps,
        sendToAsh,
        sendDirectMessage,
        parseTrackingPage,
        createReceptionRequest,
      } = buildDeps();
      parseTrackingPage.mockRejectedValueOnce(
        new Error("vision provider down"),
      );

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("on getFileUrl throwing (DM photo), sends the German recovery DM without invoking the tracking-page vision tool", async () => {
      const {
        deps,
        sendToAsh,
        sendDirectMessage,
        parseTrackingPage,
        getFileUrl,
        createReceptionRequest,
      } = buildDeps();
      getFileUrl.mockRejectedValueOnce(new Error("Bot API 404"));

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(parseTrackingPage).not.toHaveBeenCalled();
      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("on high-confidence but unregistered caller, sends the German recovery DM (no Resident to attach the request to)", async () => {
      const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
        buildDeps({
          parsedTrackingPage: {
            carrier: "DHL",
            absenceSignal: true,
            confidence: "high",
            reason: "clean tracking page",
          },
          registeredResident: null,
        });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      // The recovery DM embeds the /register hint inline so an
      // unregistered photo sender gets the right next step without a
      // second turn.
      expect(sendDirectMessage.mock.calls[0]![1]).toContain("/register");
    });

    it("on high-confidence + createReceptionRequest throwing (Redis hiccup), sends the German recovery DM", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
        buildDeps({
          parsedTrackingPage: {
            carrier: "DHL",
            absenceSignal: true,
            confidence: "high",
            reason: "clean tracking page",
          },
          registeredResident: resident,
        });
      createReceptionRequest.mockRejectedValueOnce(new Error("redis down"));

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      // The throw means no card was posted. User gets the recovery
      // prompt instead — better than an ack for a card that's not up.
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("on anonymous DM photo (no fromUserId), sends the German recovery DM without consulting the directory", async () => {
      const {
        deps,
        sendToAsh,
        sendDirectMessage,
        createReceptionRequest,
        getRegisteredResident,
      } = buildDeps({
        parsedTrackingPage: {
          carrier: "DHL",
          absenceSignal: true,
          confidence: "high",
          reason: "clean tracking page",
        },
      });

      await processInboundTelegramUpdate(
        // No `from` field → fromUserId is null.
        makeRequest(dmPhotoUpdate({})),
        deps,
      );

      expect(getRegisteredResident).not.toHaveBeenCalled();
      expect(createReceptionRequest).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("uses the resident's stored language for the ack DM when present (tr)", async () => {
      const resident = dmRegisteredResident("tr");
      const { deps, sendToAsh, sendDirectMessage } = buildDeps({
        parsedTrackingPage: {
          carrier: "DHL",
          absenceSignal: true,
          confidence: "high",
          reason: "clean tracking page",
        },
        registeredResident: resident,
      });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "tr" })),
        deps,
      );

      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Gruba sordum — biri yanıt verince haber veririm.",
      );
    });

    it("falls back to the Telegram client language code when the resident has no stored language (en)", async () => {
      const resident: Resident = {
        ...dmRegisteredResident("de"),
        language: undefined,
      };
      const { deps, sendToAsh, sendDirectMessage } = buildDeps({
        parsedTrackingPage: {
          carrier: "DHL",
          absenceSignal: true,
          confidence: "high",
          reason: "clean tracking page",
        },
        registeredResident: resident,
      });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "en" })),
        deps,
      );

      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Asked in the group — I'll let you know as soon as someone says yes.",
      );
    });

    it("falls back to 'de' when neither the resident nor Telegram supply a language code on the low-confidence path", async () => {
      const { deps, sendToAsh, sendDirectMessage } = buildDeps({
        parsedTrackingPage: {
          carrier: "unknown",
          confidence: "low",
          reason: "blurry image",
        },
      });

      // No language_code on the Telegram side AND unregistered caller.
      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99 })),
        deps,
      );

      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage.mock.calls[0]![1]).toContain(
        "Ich konnte den Beleg nicht eindeutig lesen",
      );
    });

    it("still sends the recovery DM (no agent fallback) even when the photo arrives without a caption on the low-confidence path", async () => {
      const { deps, sendToAsh, sendDirectMessage } = buildDeps({
        parsedTrackingPage: {
          carrier: "unknown",
          confidence: "low",
          reason: "blurry image",
        },
      });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    });

  });

  it("does not call getFileUrl on text-only updates", async () => {
    const { deps, getFileUrl } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 5, text: "hi", fromUserId: 99 })),
      deps,
    );

    expect(getFileUrl).not.toHaveBeenCalled();
  });

  it("records a KnownTelegramUser observation for every actionable inbound message (#45 passive directory)", async () => {
    const { deps, recordTelegramObservation } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 5, type: "supergroup" },
          text: "moin",
          from: {
            id: 999,
            is_bot: false,
            first_name: "Diego",
            last_name: "de Miguel",
            username: "diego_demiguel",
            language_code: "de",
          },
        },
      }),
      deps,
    );

    expect(recordTelegramObservation).toHaveBeenCalledTimes(1);
    expect(recordTelegramObservation).toHaveBeenCalledWith({
      userId: 999,
      firstName: "Diego",
      lastName: "de Miguel",
      username: "diego_demiguel",
      languageCode: "de",
      chatId: 5,
    });
  });

  it("does not record an observation when the inbound update has no fromUserId (anonymous group post)", async () => {
    const { deps, recordTelegramObservation } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 5, type: "supergroup" },
          text: "anon",
          // no `from`
        },
      }),
      deps,
    );

    expect(recordTelegramObservation).not.toHaveBeenCalled();
  });

  it("does not crash the turn when recordTelegramObservation throws (best-effort)", async () => {
    const { deps, recordTelegramObservation, sendToAsh } = buildDeps();
    recordTelegramObservation.mockRejectedValueOnce(new Error("redis exploded"));

    const response = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 5, text: "hi", fromUserId: 99 })),
      deps,
    );

    expect(response.status).toBe(204);
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });
});

describe("processInboundTelegramUpdate — callback_query", () => {
  function cbUpdate(opts: {
    chatId: number;
    messageId: number;
    fromUserId: number;
    data: string;
    chatType?: string;
    languageCode?: string;
  }): Record<string, unknown> {
    return {
      update_id: 100,
      callback_query: {
        id: "cb_abc",
        data: opts.data,
        from: {
          id: opts.fromUserId,
          is_bot: false,
          first_name: "T",
          language_code: opts.languageCode,
        },
        message: {
          message_id: opts.messageId,
          chat: { id: opts.chatId, type: opts.chatType ?? "private" },
        },
      },
    };
  }

  it("synthesizes an apology message when a stale 'accept_reception_request:req_99' callback arrives (Slice 5 #90 — tool deleted)", async () => {
    // The v2.1 group-card flow uses `accept_reception_group:<id>` — the
    // legacy `accept_reception_request:<id>` callback is no longer wired
    // anywhere, but Telegram can still deliver it from an old keyboard
    // sitting in a stale chat. With the backing tool deleted, the
    // synthetic must NOT prompt the agent to re-run a procedure that
    // would call accept_reception_request; it should produce a soft
    // apology instead.
    const { deps, sendToAsh } = buildDeps();
    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: 42,
          messageId: 1,
          fromUserId: 99,
          data: "accept_reception_request:req_99",
        }),
      ),
      deps,
    );
    const [text] = sendToAsh.mock.calls[0]!;
    expect(text).toMatch(/old 'I can help' button/i);
    expect(text).not.toContain("accept_reception_request");
  });

  it("synthesizes a decline message that tells the agent to acknowledge briefly", async () => {
    const { deps, sendToAsh } = buildDeps();
    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: 42,
          messageId: 1,
          fromUserId: 99,
          data: "decline_reception_request:req_99",
        }),
      ),
      deps,
    );
    const [text] = sendToAsh.mock.calls[0]!;
    expect(text).toMatch(/declin/i);
    expect(text).toMatch(/req_99/);
  });

  describe("confirm_pickup tap (v2.1 #108 — channel-deterministic Flow 1 pickup)", () => {
    // The pre-#108 surface ack'd + strip'd the keyboard, then synthesised a
    // `[button-tap]` message into the agent (sendToAsh). After v2.1 #108
    // the channel handles the tap end-to-end: `confirmPickup` flips the
    // status, the orchestrator DMs the holder thanks + strips the
    // recipient DM keyboard. `sendToAsh` is NEVER called on this path —
    // that is the structural invariant these cases pin. v2.1 #114
    // additionally pins that the group-ack edit no longer fires.

    it("flips status, strips the recipient DM keyboard, and DMs the holder thanks on the happy path — v2.1 #114: no editGroupCard call", async () => {
      const {
        deps,
        sendToAsh,
        confirmPickup,
        answerCallback,
        stripKeyboard,
        editGroupCard,
        sendDirectMessage,
        getRegisteredResident,
      } = buildDeps({
        registeredResident: {
          id: "200",
          name: "Marlene Hartmann",
          street: "Methfesselstraße",
          houseNumber: "88",
          platformId: "200",
          platform: "telegram",
          language: "de",
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        } satisfies Resident,
      });

      // v2.1 #114: in the new design the pickup keyboard lives only
      // on the recipient's 1:1 DM (chatId = recipient.platformId).
      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: 200, // recipient's DM chat
            messageId: 777,
            fromUserId: 200,
            data: "confirm_pickup:pkg_42",
            chatType: "private",
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);

      // Channel resolved the caller, called the lib, then ack'd + stripped.
      expect(getRegisteredResident).toHaveBeenCalledWith(200);
      expect(confirmPickup).toHaveBeenCalledTimes(1);
      expect(confirmPickup.mock.calls[0]![1]).toBe("pkg_42");
      expect(answerCallback).toHaveBeenCalledWith("cb_abc");
      // Strip targets the recipient DM message (the only surface that
      // carries the pickup keyboard post-#114).
      expect(stripKeyboard).toHaveBeenCalledWith(200, 777);

      // v2.1 #114 regression pin: no editGroupCard call. The group
      // ack stays as the original "📦 Paket von X an Y." announcement
      // — pickup is private business between the recipient and the
      // bot, so the group never learns the package was closed.
      expect(editGroupCard).not.toHaveBeenCalled();

      // Holder thanks DM lands.
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      const [holderChatId, dmText] = sendDirectMessage.mock.calls[0]!;
      expect(holderChatId).toBe(100); // holder.platformId from default mock
      expect(dmText).toContain("Marlene Hartmann");
      expect(dmText).toContain("danke");

      // Agent is NEVER invoked on this path.
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("PICKUP_NOT_RECIPIENT throw → dedicated toast, NO keyboard strip (v2.1 #114: stale group keyboard stays untouched), no DMs", async () => {
      const { PICKUP_NOT_RECIPIENT_ERROR_CODE } = await import("../pickup.js");
      const err: Error & { code?: string } = new Error("not recipient");
      err.code = PICKUP_NOT_RECIPIENT_ERROR_CODE;

      const {
        deps,
        sendToAsh,
        confirmPickup,
        answerCallback,
        stripKeyboard,
        editGroupCard,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: {
          id: "999",
          name: "Some Neighbor",
          street: "Methfesselstraße",
          houseNumber: "10",
          platformId: "999",
          platform: "telegram",
          language: "de",
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        } satisfies Resident,
        confirmPickupError: err,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 999,
            data: "confirm_pickup:pkg_42",
            chatType: "supergroup",
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(confirmPickup).toHaveBeenCalledTimes(1);
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/nicht der empfänger/i),
      );
      // v2.1 #114: keyboard stays live. The only way a non-recipient
      // can tap is via a stale pre-#114 group keyboard — stripping
      // it would punish every other resident's view of that
      // historical message. The recipient's DM keyboard is untouched
      // either way (it's on a different chat).
      expect(stripKeyboard).not.toHaveBeenCalled();
      // No edit, no DM, no agent invocation.
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("PICKUP_ALREADY_DONE throw → dedicated toast, NO keyboard strip (already stripped from previous success)", async () => {
      const { PICKUP_ALREADY_DONE_ERROR_CODE } = await import("../pickup.js");
      const err: Error & { code?: string } = new Error("already picked up");
      err.code = PICKUP_ALREADY_DONE_ERROR_CODE;

      const {
        deps,
        sendToAsh,
        answerCallback,
        stripKeyboard,
        editGroupCard,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: {
          id: "200",
          name: "Marlene Hartmann",
          street: "Methfesselstraße",
          houseNumber: "88",
          platformId: "200",
          platform: "telegram",
          language: "en",
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        } satisfies Resident,
        confirmPickupError: err,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 200,
            data: "confirm_pickup:pkg_42",
            chatType: "supergroup",
            languageCode: "en",
          }),
        ),
        deps,
      );

      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/already.*picked up/i),
      );
      expect(stripKeyboard).not.toHaveBeenCalled();
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("generic confirmPickup throw (Redis hiccup) → retry toast + keyboard stays live", async () => {
      const {
        deps,
        sendToAsh,
        answerCallback,
        stripKeyboard,
        editGroupCard,
      } = buildDeps({
        registeredResident: {
          id: "200",
          name: "Marlene Hartmann",
          street: "Methfesselstraße",
          houseNumber: "88",
          platformId: "200",
          platform: "telegram",
          language: "de",
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        } satisfies Resident,
        confirmPickupError: new Error("upstash 500"),
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 200,
            data: "confirm_pickup:pkg_42",
            chatType: "supergroup",
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/schiefgelaufen/i),
      );
      // Keyboard stays live — caller can retry.
      expect(stripKeyboard).not.toHaveBeenCalled();
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("unregistered tapper → not-recipient toast, NO keyboard strip (v2.1 #114: stale group keyboard stays untouched), no lib call", async () => {
      const {
        deps,
        sendToAsh,
        confirmPickup,
        answerCallback,
        stripKeyboard,
        getRegisteredResident,
      } = buildDeps({ registeredResident: null });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 99,
            data: "confirm_pickup:pkg_42",
            chatType: "supergroup",
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(getRegisteredResident).toHaveBeenCalledWith(99);
      // Lib never called for unregistered taps — the channel rejects
      // them as non-recipients (an unregistered user can't be the
      // recipient of any Package by definition).
      expect(confirmPickup).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/nicht der empfänger/i),
      );
      // v2.1 #114: keyboard stays live. Same rationale as the
      // PICKUP_NOT_RECIPIENT branch — only path here is a stale
      // pre-#114 group keyboard, and stripping it punishes the
      // whole group.
      expect(stripKeyboard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("getRegisteredResident throws → retry toast + keyboard stays live, no lib call", async () => {
      const {
        deps,
        sendToAsh,
        confirmPickup,
        answerCallback,
        stripKeyboard,
        getRegisteredResident,
      } = buildDeps();
      getRegisteredResident.mockRejectedValueOnce(new Error("redis hiccup"));

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 200,
            data: "confirm_pickup:pkg_42",
            chatType: "supergroup",
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(confirmPickup).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/schiefgelaufen/i),
      );
      expect(stripKeyboard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("holder thanks DM failure is swallowed (canonical state already correct) — v2.1 #114: editGroupCard is no longer called", async () => {
      const {
        deps,
        sendToAsh,
        editGroupCard,
        sendDirectMessage,
      } = buildDeps({
        registeredResident: {
          id: "200",
          name: "Marlene Hartmann",
          street: "Methfesselstraße",
          houseNumber: "88",
          platformId: "200",
          platform: "telegram",
          language: "de",
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        } satisfies Resident,
      });
      sendDirectMessage.mockRejectedValueOnce(new Error("dm failed"));

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: 200, // recipient DM (the only surface with the keyboard)
            messageId: 777,
            fromUserId: 200,
            data: "confirm_pickup:pkg_42",
            chatType: "private",
          }),
        ),
        deps,
      );

      // The holder-thanks DM was attempted (and failed), but the
      // overall response stays 204 because the lib already flipped
      // canonical state — surfacing a 5xx now would be misleading.
      expect(res.status).toBe(204);
      // v2.1 #114: editGroupCard is never called on pickup.
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("records a KnownTelegramUser observation on every pickup tap, including rejected ones (#45 preservation)", async () => {
      const { deps, sendToAsh, recordTelegramObservation, confirmPickup } =
        buildDeps({ registeredResident: null });

      await processInboundTelegramUpdate(
        makeRequest({
          update_id: 1,
          callback_query: {
            id: "cb_abc",
            data: "confirm_pickup:pkg_42",
            from: {
              id: 4242,
              is_bot: false,
              first_name: "Natascha",
              last_name: "Elter",
              username: "natascha_elter",
              language_code: "de",
            },
            message: {
              message_id: 555,
              chat: { id: -1001, type: "supergroup" },
            },
          },
        }),
        deps,
      );

      expect(confirmPickup).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(recordTelegramObservation).toHaveBeenCalledTimes(1);
      expect(recordTelegramObservation).toHaveBeenCalledWith({
        userId: 4242,
        firstName: "Natascha",
        lastName: "Elter",
        username: "natascha_elter",
        languageCode: "de",
        chatId: -1001,
      });
    });

    it("does NOT pass confirm_pickup to setTriggerAttribute — no agent run means no Trigger row to attribute", async () => {
      const { deps, setTriggerAttribute } = buildDeps({
        registeredResident: {
          id: "200",
          name: "Marlene Hartmann",
          street: "Methfesselstraße",
          houseNumber: "88",
          platformId: "200",
          platform: "telegram",
          language: "de",
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        } satisfies Resident,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 200,
            data: "confirm_pickup:pkg_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      // The legacy `telegram.callback-confirm-pickup` value is gone in
      // v2.1 #108. The channel-deterministic pickup path never calls
      // `sendToAsh`, so there is no `ash.turn` row for the dashboard
      // to attribute — same as the volunteer-accept path (#96).
      expect(setTriggerAttribute).not.toHaveBeenCalled();
    });
  });

  it("falls through to message handling when the update has no callback_query", async () => {
    const { deps, sendToAsh, answerCallback } = buildDeps();
    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 5, text: "hi", fromUserId: 99 })),
      deps,
    );
    expect(answerCallback).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("handles an unknown action by synthesizing a permissive message", async () => {
    const { deps, sendToAsh } = buildDeps();
    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: 42,
          messageId: 1,
          fromUserId: 99,
          data: "weird_action:42",
        }),
      ),
      deps,
    );
    const [text] = sendToAsh.mock.calls[0]!;
    expect(text).toMatch(/weird_action/);
  });

  describe("accept_reception_group (v2.1 #96 — channel-deterministic DMs, no agent invocation)", () => {
    /** Reusable volunteer Resident shape for the channel's `getRegisteredResident` dep. */
    function makeVolunteer(overrides: Partial<Resident> = {}): Resident {
      return {
        id: "300",
        name: "Marlene Hartmann",
        street: "Methfesselstraße",
        houseNumber: "88",
        floor: "V.",
        buzzerName: "Hartmann",
        platformId: "300",
        platform: "telegram",
        language: "de",
        availabilityPatterns: [],
        registeredAt: Date.now(),
        source: "explicit",
        confirmed: true,
        ...overrides,
      };
    }

    it("flips the request + edits the card + sends both DMs deterministically, NEVER invoking the agent (#96 Part A)", async () => {
      const volunteer = makeVolunteer();
      const {
        deps,
        sendToAsh,
        stripKeyboard,
        isRegisteredResident,
        getRegisteredResident,
        acceptReceptionRequest,
        editGroupCard,
        sendDirectMessage,
      } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(isRegisteredResident).toHaveBeenCalledWith(300);
      expect(stripKeyboard).toHaveBeenCalledWith(-100123, 555);
      expect(getRegisteredResident).toHaveBeenCalledWith(300);
      expect(acceptReceptionRequest).toHaveBeenCalledTimes(1);
      expect(acceptReceptionRequest).toHaveBeenCalledWith(volunteer, {
        requestId: "req_42",
      });
      // Availability is intentionally omitted — the tap alone is the
      // "I can help" signal; the DMs go out without a stated window.
      const acceptInput = acceptReceptionRequest.mock.calls[0]![1] as {
        availability?: string;
      };
      expect(acceptInput.availability).toBeUndefined();

      expect(editGroupCard).toHaveBeenCalledTimes(1);
      expect(editGroupCard).toHaveBeenCalledWith(
        -100123,
        555,
        "✅ angenommen von Marlene Hartmann",
      );

      // Call order:
      //   accept → stripKeyboard → editGroupCard → sendDirectMessage(×2).
      // (stripKeyboard runs AFTER accept so a thrown accept leaves the
      // keyboard intact for a re-tap — v2.1 Bug 3 / #95.)
      expect(acceptReceptionRequest.mock.invocationCallOrder[0]).toBeLessThan(
        stripKeyboard.mock.invocationCallOrder[0]!,
      );
      expect(stripKeyboard.mock.invocationCallOrder[0]).toBeLessThan(
        editGroupCard.mock.invocationCallOrder[0]!,
      );
      expect(editGroupCard.mock.invocationCallOrder[0]).toBeLessThan(
        sendDirectMessage.mock.invocationCallOrder[0]!,
      );

      // #96 Part A: TWO deterministic DMs, ZERO sendToAsh.
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);

      // Volunteer DM (operational handoff) → chatId = volunteer.platformId = 300.
      const [volChatId, volText, volEntities] = sendDirectMessage.mock.calls[0]!;
      expect(volChatId).toBe(300);
      expect(typeof volText).toBe("string");
      // Volunteer's language is "de" → German operational template.
      expect(volText).toMatch(/^Danke fürs Helfen!/);
      expect(volText).toContain("Patricia Höfer");
      expect(volText).toContain("Haus 90");
      expect(volText).toContain("Etage: II.");
      expect(volText).toContain("Klingel: Höfer");
      expect(volText).toContain("Carrier: DHL");
      // Window is rendered as Berlin-local same-day if today.
      // Defensive: assert just that *something* window-shaped lands.
      expect(volText).toMatch(/Erwartet: /);
      // Volunteer DM has NO text_mention entity (it names the
      // requester, not the volunteer — and the recipient IS the
      // volunteer, so no need to mention self).
      expect(volEntities).toBeUndefined();
      // The synthetic shape this used to produce MUST NOT leak into
      // the deterministic DM text — that string belongs to a deleted
      // code path.
      expect(volText).not.toContain("[VOLUNTEER_ACCEPTED");

      // Requester DM (named confirmation) → chatId = requester.id = 200.
      const [reqChatId, reqText, reqEntities] = sendDirectMessage.mock.calls[1]!;
      expect(reqChatId).toBe(200);
      expect(typeof reqText).toBe("string");
      // Requester's language is "de" → German confirmation template
      // starts with the volunteer's name (so the text_mention offset
      // is at 0).
      expect(reqText).toMatch(/^Marlene Hartmann aus Haus 88 nimmt dein DHL-Paket/);
      expect(reqText).toContain("entgegen.");

      // text_mention entity pings the volunteer at the start of the
      // string (offset 0, length = len("Marlene Hartmann")).
      expect(reqEntities).toEqual([
        {
          type: "text_mention",
          offset: 0,
          length: "Marlene Hartmann".length,
          user: { id: 300 },
        },
      ]);
    });

    it("renders DMs in each party's stored language (volunteer=en, requester=de)", async () => {
      const englishVolunteer = makeVolunteer({
        language: "en",
        // Re-shape platformId to a different id for clarity.
        platformId: "400",
        id: "400",
        name: "Marlene",
        floor: undefined,
        buzzerName: undefined,
      });
      // Build an accept result with mixed languages.
      const mixed: AcceptReceptionRequestResult = {
        request: {
          id: "req_mix",
          streetId: "Methfesselstraße",
          requesterResidentId: "200",
          requesterName: "Patricia",
          requesterHouseNumber: "90",
          carrier: "DHL",
          expectedAt: null,
          volunteerResidentId: "400",
          volunteerAvailability: null,
          status: "matched",
          createdAt: Date.now(),
          respondedAt: Date.now(),
          groupCardChatId: -100123,
          groupCardMessageId: 555,
        } satisfies ReceptionRequest,
        requester: {
          id: "200",
          name: "Patricia",
          houseNumber: "90",
          language: "de",
          floor: null,
          buzzerName: null,
        },
        volunteer: {
          id: "400",
          name: "Marlene",
          houseNumber: "88",
          language: "en",
          floor: null,
          buzzerName: null,
          platformId: "400",
        },
        groupCardChatId: -100123,
        groupCardMessageId: 555,
      };
      const { deps, sendDirectMessage, sendToAsh } = buildDeps({
        isRegisteredResident: true,
        registeredResident: englishVolunteer,
        acceptResult: mixed,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 400,
            data: "accept_reception_group:req_mix",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);

      // Volunteer DM → English template.
      const [, volText] = sendDirectMessage.mock.calls[0]!;
      expect(volText).toMatch(/^Thanks for helping!/);

      // Requester DM → German template (named confirmation).
      const [, reqText] = sendDirectMessage.mock.calls[1]!;
      expect(reqText).toMatch(/^Marlene aus Haus 88 nimmt dein DHL-Paket/);
    });

    it("renders Spanish + Turkish templates with German fallback for unknown languages", async () => {
      const cases: ReadonlyArray<{
        language: string;
        expectedPrefix: RegExp;
      }> = [
        { language: "es", expectedPrefix: /^¡Gracias por ayudar!/ },
        { language: "tr", expectedPrefix: /^Yardım ettiğin için teşekkürler!/ },
        // Unknown language → German fallback.
        { language: "xx", expectedPrefix: /^Danke fürs Helfen!/ },
      ];

      for (const { language, expectedPrefix } of cases) {
        const volunteer = makeVolunteer({ language });
        // Build an acceptResult whose volunteer.language matches the
        // language under test — the template picker reads
        // `accepted.volunteer.language`, not the looked-up Resident.
        const acceptResult: AcceptReceptionRequestResult = {
          request: {
            id: "req_42",
            streetId: "Methfesselstraße",
            requesterResidentId: "200",
            requesterName: "Patricia",
            requesterHouseNumber: "90",
            carrier: "DHL",
            expectedAt: null,
            volunteerResidentId: "300",
            volunteerAvailability: null,
            status: "matched",
            createdAt: Date.now(),
            respondedAt: Date.now(),
            groupCardChatId: -100123,
            groupCardMessageId: 555,
          } satisfies ReceptionRequest,
          requester: {
            id: "200",
            name: "Patricia",
            houseNumber: "90",
            language: "de",
            floor: null,
            buzzerName: null,
          },
          volunteer: {
            id: "300",
            name: "Marlene",
            houseNumber: "88",
            language,
            floor: null,
            buzzerName: null,
            platformId: "300",
          },
          groupCardChatId: -100123,
          groupCardMessageId: 555,
        };
        const { deps, sendDirectMessage } = buildDeps({
          isRegisteredResident: true,
          registeredResident: volunteer,
          acceptResult,
        });

        await processInboundTelegramUpdate(
          makeRequest(
            cbUpdate({
              chatId: -100123,
              messageId: 555,
              fromUserId: 300,
              data: "accept_reception_group:req_42",
              chatType: "supergroup",
            }),
          ),
          deps,
        );

        expect(sendDirectMessage).toHaveBeenCalled();
        const [, volText] = sendDirectMessage.mock.calls[0]!;
        expect(volText).toMatch(expectedPrefix);
      }
    });

    it("omits carrier / window / floor / buzzer from BOTH DMs when the request has neither (#96 Part A — sparse request)", async () => {
      const volunteer = makeVolunteer();
      const sparse: AcceptReceptionRequestResult = {
        request: {
          id: "req_99",
          streetId: "Methfesselstraße",
          requesterResidentId: "200",
          requesterName: "Patricia",
          requesterHouseNumber: "90",
          carrier: "unknown",
          expectedAt: null,
          volunteerResidentId: "300",
          volunteerAvailability: null,
          status: "matched",
          createdAt: Date.now(),
          respondedAt: Date.now(),
          groupCardChatId: -100123,
          groupCardMessageId: 555,
        } satisfies ReceptionRequest,
        requester: {
          id: "200",
          name: "Patricia",
          houseNumber: "90",
          language: "de",
          floor: null,
          buzzerName: null,
        },
        volunteer: {
          id: "300",
          name: "Marlene",
          houseNumber: "88",
          language: "de",
          floor: null,
          buzzerName: null,
          platformId: "300",
        },
        groupCardChatId: -100123,
        groupCardMessageId: 555,
      };
      const { deps, sendDirectMessage } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
        acceptResult: sparse,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_99",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      const [, volText] = sendDirectMessage.mock.calls[0]!;
      // Volunteer DM: no carrier/window/floor/buzzer phrases.
      expect(volText).not.toMatch(/Carrier:/);
      expect(volText).not.toMatch(/Erwartet:/);
      expect(volText).not.toMatch(/Etage:/);
      expect(volText).not.toMatch(/Klingel:/);

      const [, reqText] = sendDirectMessage.mock.calls[1]!;
      // Requester DM: generic "Paket" (no carrier prefix) + no
      // window phrase.
      expect(reqText).toMatch(/dein Paket entgegen\.$/);
      expect(reqText).not.toMatch(/DHL/);
    });

    it("FAILS LOUD when getRegisteredResident returns null (gate/lookup race): toast, no DMs, no agent call, keyboard intact (v2.1 Bug 3 / #95)", async () => {
      const {
        deps,
        sendToAsh,
        acceptReceptionRequest,
        editGroupCard,
        answerCallback,
        stripKeyboard,
        sendDirectMessage,
      } = buildDeps({
        isRegisteredResident: true, // gate admits
        registeredResident: null, // race: lookup returns null
      });

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(acceptReceptionRequest).not.toHaveBeenCalled();
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
      );
      expect(stripKeyboard).not.toHaveBeenCalled();
    });

    it("FAILS LOUD when acceptReceptionRequest throws with a recoverable error: generic toast, no DMs, no agent call, keyboard intact (v2.1 Bug 3 / #95)", async () => {
      const volunteer = makeVolunteer({ language: "de" });
      const {
        deps,
        sendToAsh,
        acceptReceptionRequest,
        editGroupCard,
        answerCallback,
        stripKeyboard,
        sendDirectMessage,
      } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
      });
      acceptReceptionRequest.mockRejectedValueOnce(
        new Error("request already matched"),
      );

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
      );
      // Keyboard stays live on recoverable failure → user can re-tap.
      expect(stripKeyboard).not.toHaveBeenCalled();
    });

    it("renders the dedicated cross-street toast AND strips the keyboard when acceptReceptionRequest throws with code ACCEPT_DIFFERENT_STREET (#96 Part B)", async () => {
      const volunteer = makeVolunteer({ language: "de" });
      const {
        deps,
        sendToAsh,
        acceptReceptionRequest,
        editGroupCard,
        answerCallback,
        stripKeyboard,
        sendDirectMessage,
      } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
      });
      // Build the typed cross-street error so the handler can branch
      // on `.code`. Doing it inline (vs importing the class) keeps
      // the test independent of the lib's export shape — the
      // handler's contract is "the error has a `.code` field equal
      // to the string `ACCEPT_DIFFERENT_STREET`".
      const crossStreet = Object.assign(
        new Error("different street"),
        { code: "ACCEPT_DIFFERENT_STREET", name: "AcceptReceptionRequestError" },
      );
      acceptReceptionRequest.mockRejectedValueOnce(crossStreet);

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(acceptReceptionRequest).toHaveBeenCalledTimes(1);
      expect(editGroupCard).not.toHaveBeenCalled();
      // No agent invocation, no DMs.
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      // Dedicated toast (de) — NOT the generic retry shape.
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Du und dieser Nachbar müsst auf derselben Straße wohnen.",
      );
      // Keyboard IS stripped — the cross-street constraint is permanent;
      // the volunteer cannot succeed by re-tapping the same button.
      expect(stripKeyboard).toHaveBeenCalledWith(-100123, 555);
    });

    it("localises the cross-street toast across de/en/es/tr (#96 Part B)", async () => {
      const cases: ReadonlyArray<{ language: string; expected: string }> = [
        { language: "de", expected: "Du und dieser Nachbar müsst auf derselben Straße wohnen." },
        { language: "en", expected: "You and this neighbor must live on the same street." },
        { language: "es", expected: "Tú y este vecino debéis vivir en la misma calle." },
        { language: "tr", expected: "Sen ve bu komşu aynı sokakta yaşamalısınız." },
      ];

      for (const { language, expected } of cases) {
        const volunteer = makeVolunteer({ language });
        const { deps, acceptReceptionRequest, answerCallback, stripKeyboard } =
          buildDeps({
            isRegisteredResident: true,
            registeredResident: volunteer,
          });
        const crossStreet = Object.assign(
          new Error("different street"),
          { code: "ACCEPT_DIFFERENT_STREET" },
        );
        acceptReceptionRequest.mockRejectedValueOnce(crossStreet);

        await processInboundTelegramUpdate(
          makeRequest(
            cbUpdate({
              chatId: -100123,
              messageId: 555,
              fromUserId: 300,
              data: "accept_reception_group:req_42",
              chatType: "supergroup",
            }),
          ),
          deps,
        );

        expect(answerCallback).toHaveBeenCalledWith("cb_abc", expected);
        expect(stripKeyboard).toHaveBeenCalledWith(-100123, 555);
      }
    });

    // #98: requester taps their own card. Permanent rejection (a
    // request's `requesterResidentId` doesn't change), so the channel
    // strips the keyboard alongside the dedicated toast — same shape as
    // the cross-street rejection. Keyboard-strip closes the loop so the
    // same fat-finger / autocomplete / voice-to-text mistap can't fire
    // twice from the same surface. Live trace 2026-05-22 (prod
    // `dpl_8A1T6ECT4ttiWRnBHot7Sa3vEUC9`): a requester accidentally
    // typed `Si` (Spanish "yes") which the channel routed as an accept
    // tap on their own card; the lib happily flipped the request to
    // `matched` with `volunteerResidentId === requesterResidentId`, the
    // DM-pair fired both ways, and the data path then contradicted
    // itself, surfacing the v1-style cascade in the GROUP.
    it("renders the dedicated self-accept toast and KEEPS THE KEYBOARD LIVE when acceptReceptionRequest throws with code ACCEPT_RECEPTION_SELF_NOT_ALLOWED (#98 / #101)", async () => {
      const requester = makeVolunteer({ language: "de" });
      const {
        deps,
        sendToAsh,
        acceptReceptionRequest,
        editGroupCard,
        answerCallback,
        stripKeyboard,
        sendDirectMessage,
      } = buildDeps({
        isRegisteredResident: true,
        registeredResident: requester,
      });
      const selfAccept = Object.assign(
        new Error("cannot volunteer for your own request"),
        {
          code: "ACCEPT_RECEPTION_SELF_NOT_ALLOWED",
          name: "AcceptReceptionRequestError",
        },
      );
      acceptReceptionRequest.mockRejectedValueOnce(selfAccept);

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(acceptReceptionRequest).toHaveBeenCalledTimes(1);
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Du kannst dein eigenes Paket nicht selbst annehmen.",
      );
      // #101: keyboard MUST stay live so other neighbours on the same
      // street can still claim. The rejection is per-tapper, not per-card.
      expect(stripKeyboard).not.toHaveBeenCalled();
    });

    it("leaves the keyboard live so another neighbour can claim the SAME card after a self-tap (#101)", async () => {
      const requester = makeVolunteer({ id: "300", language: "de" });
      const otherNeighbour = makeVolunteer({
        id: "400",
        platformId: "400",
        name: "Natascha Other",
        language: "de",
      });
      const {
        deps,
        sendToAsh,
        acceptReceptionRequest,
        editGroupCard,
        answerCallback,
        stripKeyboard,
        sendDirectMessage,
        getRegisteredResident,
      } = buildDeps({
        isRegisteredResident: true,
        registeredResident: requester,
      });

      // First tap: the requester taps their own card → self-accept reject.
      // The default acceptResult queue is overridden for this call only.
      const selfAccept = Object.assign(
        new Error("cannot volunteer for your own request"),
        {
          code: "ACCEPT_RECEPTION_SELF_NOT_ALLOWED",
          name: "AcceptReceptionRequestError",
        },
      );
      acceptReceptionRequest.mockRejectedValueOnce(selfAccept);

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      // After self-tap: keyboard MUST still be live so another tapper can claim.
      expect(stripKeyboard).not.toHaveBeenCalled();
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();

      // Second tap on the SAME card: a different neighbour on the same
      // street claims successfully. The keyboard being live above is what
      // makes this tap reachable in real Telegram. `getRegisteredResident`
      // gets one queued response for the second tap; `acceptReceptionRequest`
      // falls back to the buildDeps default (success result).
      getRegisteredResident.mockResolvedValueOnce(otherNeighbour);

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 400,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      // Happy path: keyboard stripped + card edited + the two deterministic DMs sent.
      expect(stripKeyboard).toHaveBeenCalledTimes(1);
      expect(stripKeyboard).toHaveBeenCalledWith(-100123, 555);
      expect(editGroupCard).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledTimes(2);
    });

    it("localises the self-accept toast across de/en/es/tr without stripping the keyboard (#98 / #101)", async () => {
      const cases: ReadonlyArray<{ language: string; expected: string }> = [
        { language: "de", expected: "Du kannst dein eigenes Paket nicht selbst annehmen." },
        { language: "en", expected: "You can't volunteer for your own package." },
        { language: "es", expected: "No puedes aceptar tu propio paquete." },
        { language: "tr", expected: "Kendi paketini sen kabul edemezsin." },
      ];

      for (const { language, expected } of cases) {
        const requester = makeVolunteer({ language });
        const { deps, acceptReceptionRequest, answerCallback, stripKeyboard } =
          buildDeps({
            isRegisteredResident: true,
            registeredResident: requester,
          });
        const selfAccept = Object.assign(
          new Error("cannot volunteer for your own request"),
          { code: "ACCEPT_RECEPTION_SELF_NOT_ALLOWED" },
        );
        acceptReceptionRequest.mockRejectedValueOnce(selfAccept);

        await processInboundTelegramUpdate(
          makeRequest(
            cbUpdate({
              chatId: -100123,
              messageId: 555,
              fromUserId: 300,
              data: "accept_reception_group:req_42",
              chatType: "supergroup",
            }),
          ),
          deps,
        );

        expect(answerCallback).toHaveBeenCalledWith("cb_abc", expected);
        expect(stripKeyboard).not.toHaveBeenCalled();
      }
    });

    it("localizes the failure toast to the volunteer's stored Resident.language (en) when acceptReceptionRequest throws (v2.1 Bug 3 / #95)", async () => {
      const englishVolunteer = makeVolunteer({ language: "en" });
      const { deps, acceptReceptionRequest, answerCallback, sendToAsh } =
        buildDeps({
          isRegisteredResident: true,
          registeredResident: englishVolunteer,
        });
      acceptReceptionRequest.mockRejectedValueOnce(new Error("boom"));

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            // Telegram language hint deliberately wrong — stored
            // Resident.language should win.
            languageCode: "de",
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Something went wrong. Please try again.",
      );
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("falls back to Telegram's languageCode when the Resident record is null and the volunteer has no stored language (v2.1 Bug 3 / #95)", async () => {
      const { deps, answerCallback, sendToAsh } = buildDeps({
        isRegisteredResident: true,
        registeredResident: null, // null path; languageCode is the only signal
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            languageCode: "tr",
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Bir şeyler ters gitti. Lütfen tekrar deneyin.",
      );
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("falls back to German when neither Resident.language nor Telegram languageCode is set (v2.1 Bug 3 / #95)", async () => {
      const volunteer = makeVolunteer({ language: undefined });
      const { deps, acceptReceptionRequest, answerCallback, sendToAsh } =
        buildDeps({
          isRegisteredResident: true,
          registeredResident: volunteer,
        });
      acceptReceptionRequest.mockRejectedValueOnce(new Error("boom"));

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            // No languageCode at all.
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
      );
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("FAILS LOUD when getRegisteredResident throws (Redis hiccup): toast, no DMs, no agent call, keyboard intact (v2.1 Bug 3 / #95)", async () => {
      const {
        deps,
        sendToAsh,
        acceptReceptionRequest,
        editGroupCard,
        answerCallback,
        stripKeyboard,
        getRegisteredResident,
        sendDirectMessage,
      } = buildDeps({
        isRegisteredResident: true,
      });
      getRegisteredResident.mockRejectedValueOnce(new Error("redis exploded"));

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            languageCode: "es",
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(acceptReceptionRequest).not.toHaveBeenCalled();
      expect(editGroupCard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).not.toHaveBeenCalled();
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        "Algo salió mal. Por favor inténtalo de nuevo.",
      );
      expect(stripKeyboard).not.toHaveBeenCalled();
    });

    it("still sends both DMs when editGroupCard throws (state flip already landed) — #96 Part A: no agent invocation either way", async () => {
      const volunteer = makeVolunteer();
      const { deps, sendToAsh, editGroupCard, sendDirectMessage } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
      });
      editGroupCard.mockRejectedValueOnce(new Error("Bot API hiccup"));

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(editGroupCard).toHaveBeenCalledTimes(1);
      expect(sendToAsh).not.toHaveBeenCalled();
      // Both DMs still go out — the stale card can be reconciled
      // separately, but the volunteer + requester each get their
      // notification.
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it("still sends the second DM when the first DM throws (#96 Part A: don't bail mid-flow)", async () => {
      const volunteer = makeVolunteer();
      const { deps, sendDirectMessage } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
      });
      // First DM (volunteer) fails; second (requester) still goes.
      sendDirectMessage.mockRejectedValueOnce(new Error("Bot API timeout"));
      sendDirectMessage.mockResolvedValueOnce(undefined);

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it("skips editGroupCard when the request has no card on record but still sends both DMs", async () => {
      const volunteer = makeVolunteer();
      const noCardResult: AcceptReceptionRequestResult = {
        request: {
          id: "req_legacy",
          streetId: "Methfesselstraße",
          requesterResidentId: "200",
          requesterName: "Patricia",
          requesterHouseNumber: "90",
          carrier: "DHL",
          expectedAt: null,
          volunteerResidentId: "300",
          volunteerAvailability: null,
          status: "matched",
          createdAt: Date.now(),
          respondedAt: Date.now(),
          // No groupCardChatId / groupCardMessageId — defensive case where
          // the request was created but the card post failed.
        } satisfies ReceptionRequest,
        requester: {
          id: "200",
          name: "Patricia",
          houseNumber: "90",
          language: "de",
          floor: null,
          buzzerName: null,
        },
        volunteer: {
          id: "300",
          name: "Marlene",
          houseNumber: "88",
          language: "de",
          floor: null,
          buzzerName: null,
          platformId: "300",
        },
        groupCardChatId: null,
        groupCardMessageId: null,
      };
      const { deps, sendToAsh, editGroupCard, sendDirectMessage } = buildDeps({
        isRegisteredResident: true,
        registeredResident: volunteer,
        acceptResult: noCardResult,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 300,
            data: "accept_reception_group:req_legacy",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(editGroupCard).not.toHaveBeenCalled();
      // Both DMs still land — the channel doesn't need a card to
      // notify either party.
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it("rejects unregistered tappers with a German toast and leaves the keyboard intact", async () => {
      const {
        deps,
        sendToAsh,
        stripKeyboard,
        answerCallback,
        isRegisteredResident,
      } = buildDeps({ isRegisteredResident: false });

      const res = await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 4242,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(res.status).toBe(204);
      expect(isRegisteredResident).toHaveBeenCalledWith(4242);
      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/\/register/),
      );
      expect(stripKeyboard).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("treats a thrown isRegisteredResident lookup as unregistered (defensive)", async () => {
      const { deps, sendToAsh, answerCallback, isRegisteredResident } =
        buildDeps();
      isRegisteredResident.mockRejectedValueOnce(new Error("redis exploded"));

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: -100123,
            messageId: 555,
            fromUserId: 99,
            data: "accept_reception_group:req_42",
            chatType: "supergroup",
          }),
        ),
        deps,
      );

      expect(answerCallback).toHaveBeenCalledWith(
        "cb_abc",
        expect.stringMatching(/\/register/),
      );
      expect(sendToAsh).not.toHaveBeenCalled();
    });

    it("does NOT consult isRegisteredResident for non-accept-group actions", async () => {
      const { deps, sendToAsh, isRegisteredResident } = buildDeps();

      // remind_later is a legacy synthetic-path callback the channel
      // doesn't intercept itself — it still hits sendToAsh, and the
      // accept-group registration check must not fire for it.
      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: 42,
            messageId: 1,
            fromUserId: 99,
            data: "remind_later:pkg_42",
          }),
        ),
        deps,
      );

      expect(isRegisteredResident).not.toHaveBeenCalled();
      expect(sendToAsh).toHaveBeenCalledTimes(1);
    });

    it("still records the observation before the registration check (so /register flows learn the user)", async () => {
      const { deps, recordTelegramObservation, sendToAsh } = buildDeps({
        isRegisteredResident: false,
      });

      await processInboundTelegramUpdate(
        makeRequest({
          update_id: 1,
          callback_query: {
            id: "cb_abc",
            data: "accept_reception_group:req_42",
            from: {
              id: 4242,
              is_bot: false,
              first_name: "Newcomer",
              language_code: "de",
            },
            message: {
              message_id: 555,
              chat: { id: -1001, type: "supergroup" },
            },
          },
        }),
        deps,
      );

      expect(recordTelegramObservation).toHaveBeenCalledWith({
        userId: 4242,
        firstName: "Newcomer",
        lastName: undefined,
        username: undefined,
        languageCode: "de",
        chatId: -1001,
      });
      expect(sendToAsh).not.toHaveBeenCalled();
    });
  });
});

describe("processInboundTelegramUpdate — DM text → classify_dm_intent (v2.1 Slice 1, #86)", () => {
  function dmRegisteredResident(language = "de"): Resident {
    return {
      id: "patricia",
      name: "Patricia Höfer",
      street: "Methfesselstraße",
      houseNumber: "90",
      platformId: "patricia",
      platform: "telegram",
      language,
      availabilityPatterns: [],
      registeredAt: Date.now(),
      source: "explicit",
      confirmed: true,
    };
  }

  it("calls the classifier on every DM text inbound, passing text + language hint", async () => {
    const { deps, classifyDmIntent } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "Hallo, wie spät ist es?",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(classifyDmIntent).toHaveBeenCalledTimes(1);
    expect(classifyDmIntent).toHaveBeenCalledWith({
      text: "Hallo, wie spät ist es?",
      languageHint: "de",
    });
  });

  it("hands the raw text to the agent on classifier verdict kind='other'", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        kind: "other",
        absenceSignal: false,
        confidence: "low",
        reason: "chit-chat",
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 42, text: "Danke!", fromUserId: 99 })),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toBe("Danke!");
    expect(createReceptionRequest).not.toHaveBeenCalled();
  });

  it("hands the raw text to the agent on kind='flow2-reception' but confidence < high", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        confidence: "medium",
        reason: "absence but no supporting field",
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "Bin morgen nicht da", fromUserId: 99 }),
      ),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toBe("Bin morgen nicht da");
    expect(createReceptionRequest).not.toHaveBeenCalled();
  });

  it("on high-confidence Flow 2, calls createReceptionRequest and sends the German ack DM (no agent invocation, #100)", async () => {
    const resident = dmRegisteredResident("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      waitUntil,
      createReceptionRequest,
    } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        carrier: "DHL",
        expectedDate: "2026-05-22",
        expectedWindowStartAt: 1747915200000,
        expectedWindowEndAt: 1747922400000,
        confidence: "high",
        reason: "absence + DHL + window",
      },
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "Ich erwarte morgen 14-16 Uhr DHL und bin nicht zu Hause",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(createReceptionRequest).toHaveBeenCalledTimes(1);
    const [caller, input] = createReceptionRequest.mock.calls[0]!;
    expect(caller).toBe(resident);
    expect(input).toEqual({
      carrier: "DHL",
      expectedDate: "2026-05-22",
      expectedWindowStartAt: 1747915200000,
      expectedWindowEndAt: 1747922400000,
    });

    // #100: agent NEVER runs on the Flow 2 success path. The channel
    // sent the deterministic ack DM in the requester's language.
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendDirectMessage.mock.calls[0]!;
    expect(chatId).toBe(42);
    expect(text).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("uses the resident's stored language for the ack DM when present (es)", async () => {
    const resident = dmRegisteredResident("es");
    const { deps, sendToAsh, sendDirectMessage } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        carrier: "DHL",
        confidence: "high",
        reason: "absence + carrier",
      },
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "Mañana DHL, no estaré",
          fromUserId: 99,
          languageCode: "es",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Pregunté en el grupo — te aviso en cuanto alguien responda.",
    );
  });

  it("falls back to the Telegram client language code when the resident has no stored language (en)", async () => {
    const resident: Resident = {
      ...dmRegisteredResident("de"),
      language: undefined,
    };
    const { deps, sendToAsh, sendDirectMessage } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        carrier: "Hermes",
        confidence: "high",
        reason: "absence + Hermes",
      },
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "Tomorrow Hermes, I'm out",
          fromUserId: 99,
          languageCode: "en",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Asked in the group — I'll let you know as soon as someone says yes.",
    );
  });

  it("falls through to raw text when the caller is unregistered (createReceptionRequest needs a Resident)", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        carrier: "DHL",
        confidence: "high",
        reason: "absence + DHL",
      },
      registeredResident: null,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "Ich erwarte DHL und bin nicht da",
          fromUserId: 99,
        }),
      ),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toBe("Ich erwarte DHL und bin nicht da");
    expect(createReceptionRequest).not.toHaveBeenCalled();
  });

  it("falls through to raw text when the classifier throws (graceful degradation to v2 behaviour)", async () => {
    const { deps, sendToAsh, classifyDmIntent, createReceptionRequest } =
      buildDeps();
    classifyDmIntent.mockRejectedValueOnce(new Error("gateway timeout"));

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "anything", fromUserId: 99 }),
      ),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toBe("anything");
    expect(createReceptionRequest).not.toHaveBeenCalled();
  });

  it("falls through to raw text when createReceptionRequest throws (e.g. Redis hiccup)", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        carrier: "DHL",
        confidence: "high",
        reason: "absence + DHL",
      },
      registeredResident: resident,
    });
    createReceptionRequest.mockRejectedValueOnce(new Error("redis down"));

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "Ich erwarte morgen DHL und bin nicht da",
          fromUserId: 99,
        }),
      ),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    // The agent gets the raw text — better to let the user retry than
    // to give them a [FLOW_2 DONE] ack for a card that was never posted.
    expect(message).toBe("Ich erwarte morgen DHL und bin nicht da");
  });

  it("does NOT classify group messages — only DMs go through the classifier", async () => {
    const { deps, classifyDmIntent } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({
        update_id: 99,
        message: {
          message_id: 1,
          date: 1,
          text: "Ich erwarte morgen DHL und bin nicht da",
          chat: { id: -100123, type: "supergroup" },
          from: { id: 99, is_bot: false, first_name: "T" },
        },
      }),
      deps,
    );

    expect(classifyDmIntent).not.toHaveBeenCalled();
  });

  it("does NOT classify anonymous DMs (no fromUserId — synthetic create would have no caller)", async () => {
    const { deps, classifyDmIntent } = buildDeps();

    await processInboundTelegramUpdate(
      // No `from` field → fromUserId is null.
      makeRequest(dmUpdate({ chatId: 42, text: "anon msg" })),
      deps,
    );

    expect(classifyDmIntent).not.toHaveBeenCalled();
  });
});

describe("processInboundTelegramUpdate — DM-text pickup confirmation (v2.1 #110)", () => {
  function recipientResident(language = "de"): Resident {
    return {
      id: "200",
      name: "Marlene Hartmann",
      street: "Methfesselstraße",
      houseNumber: "88",
      platformId: "200",
      platform: "telegram",
      language,
      availabilityPatterns: [],
      registeredAt: Date.now(),
      source: "explicit",
      confirmed: true,
    };
  }

  function heldPackage(id: string): Package {
    return {
      id,
      streetId: "Methfesselstraße",
      recipientResidentId: "200",
      recipientName: "Marlene Hartmann",
      recipientHouseNumber: "88",
      holderResidentId: "100",
      carrier: "DHL",
      status: "held",
      receivedAt: Date.now() - 60_000,
      pickedUpAt: null,
      reminded: false,
    };
  }

  it("happy path: 1 open package → flips status via confirmPickup, sends confirmation DM + holder thanks DM, no agent invocation", async () => {
    const resident = recipientResident("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      confirmPickup,
      listOpenPackagesForRecipient,
    } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipient: [heldPackage("pkg_42")],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Hab abgeholt",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listOpenPackagesForRecipient).toHaveBeenCalledTimes(1);
    expect(confirmPickup).toHaveBeenCalledTimes(1);
    expect(confirmPickup).toHaveBeenCalledWith(resident, "pkg_42");
    expect(sendToAsh).not.toHaveBeenCalled();

    // Two DMs: confirmation to the recipient + thanks to the holder.
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(sendDirectMessage.mock.calls[0]).toEqual([
      200,
      "Hab notiert — danke!",
    ]);
    // Holder thanks DM: chatId=100 (Diego), language "de".
    expect(sendDirectMessage.mock.calls[1]![0]).toBe(100);
    expect(sendDirectMessage.mock.calls[1]![1]).toBe(
      "Marlene Hartmann hat das Paket abgeholt – danke fürs Annehmen!",
    );
  });

  it("English recipient: 1 open package + en language → English confirmation DM", async () => {
    const resident = recipientResident("en");
    const { deps, sendDirectMessage } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipient: [heldPackage("pkg_42")],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Picked up",
          fromUserId: 200,
          languageCode: "en",
        }),
      ),
      deps,
    );

    expect(sendDirectMessage.mock.calls[0]![1]).toBe("Got it — thanks!");
  });

  it("0 open packages → sends 'no open packages' DM, does NOT call confirmPickup", async () => {
    const resident = recipientResident("de");
    const { deps, sendToAsh, sendDirectMessage, confirmPickup } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipient: [],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Hab abgeholt",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(confirmPickup).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Du hast aktuell kein offenes Paket bei mir.",
    );
  });

  // v2.1 #122: defensive copy for the 0-match branch when the caller
  // has a matched RR as requester but no held Package yet.
  describe("v2.1 #122: 0 open packages + matched RR as requester → waiting-on-volunteer DM", () => {
    function matchedRequestForDiego(
      overrides: Partial<ReceptionRequest> = {},
    ): ReceptionRequest {
      return {
        id: "req_mpmac3o7_sb0isv",
        streetId: "Methfesselstraße",
        requesterResidentId: "200", // Diego (the caller in this scenario)
        requesterName: "Diego de Miguel",
        requesterHouseNumber: "88",
        carrier: "DHL",
        expectedAt: null,
        volunteerResidentId: "300", // Melanie
        volunteerAvailability: null,
        status: "matched",
        createdAt: Date.now() - 60_000,
        respondedAt: Date.now() - 30_000,
        ...overrides,
      };
    }

    function melanieResident(): Resident {
      return {
        id: "300",
        name: "Melanie Torena",
        street: "Methfesselstraße",
        houseNumber: "44",
        platformId: "300",
        platform: "telegram",
        language: "de",
        availabilityPatterns: [],
        registeredAt: Date.now(),
        source: "explicit",
        confirmed: true,
      };
    }

    it("German caller with matched RR → German waiting DM names the volunteer (no confirmPickup, no agent)", async () => {
      const resident = recipientResident("de");
      const {
        deps,
        sendToAsh,
        sendDirectMessage,
        confirmPickup,
        listMatchedReceptionRequestsForRequester,
        getResidentByPlatformId,
      } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [matchedRequestForDiego()],
        residentByPlatformId: melanieResident(),
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(listMatchedReceptionRequestsForRequester).toHaveBeenCalledTimes(1);
      expect(listMatchedReceptionRequestsForRequester).toHaveBeenCalledWith(
        resident,
      );
      expect(getResidentByPlatformId).toHaveBeenCalledWith("300");
      expect(confirmPickup).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Dein Paket ist noch nicht da – Melanie Torena nimmt es für dich an. Ich melde mich, sobald sie es übergibt.",
      );
    });

    it("English caller with matched RR → English waiting DM names the volunteer", async () => {
      const resident = recipientResident("en");
      const { deps, sendDirectMessage } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [matchedRequestForDiego()],
        residentByPlatformId: melanieResident(),
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "I picked it up",
            fromUserId: 200,
            languageCode: "en",
          }),
        ),
        deps,
      );

      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Your package isn't here yet — Melanie Torena is collecting it for you. I'll DM you the moment they hand it over.",
      );
    });

    it("multiple matched RRs → most-recent wins (the factory's ordering contract)", async () => {
      const resident = recipientResident("de");
      // listMatchedReceptionRequestsForRequester is contracted to return
      // most-recent-first; assert the channel does NOT re-sort or pick
      // by some other criterion (e.g. carrier preference).
      const newest = matchedRequestForDiego({
        id: "req_newest",
        volunteerResidentId: "300", // Melanie
        createdAt: Date.now() - 10_000,
      });
      const older = matchedRequestForDiego({
        id: "req_older",
        volunteerResidentId: "400", // someone else
        createdAt: Date.now() - 100_000,
      });
      const { deps, sendDirectMessage, getResidentByPlatformId } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [newest, older],
        residentByPlatformId: melanieResident(),
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      // Only the newest RR's volunteer should be resolved; the older
      // RR (volunteer id "400") must not be looked up.
      expect(getResidentByPlatformId).toHaveBeenCalledTimes(1);
      expect(getResidentByPlatformId).toHaveBeenCalledWith("300");
      expect(sendDirectMessage.mock.calls[0]![1]).toContain("Melanie Torena");
    });

    it("matched RR + getResidentByPlatformId returns null → falls back to volunteer-name-free phrasing", async () => {
      const resident = recipientResident("en");
      const { deps, sendDirectMessage } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [matchedRequestForDiego()],
        residentByPlatformId: null,
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "I picked it up",
            fromUserId: 200,
            languageCode: "en",
          }),
        ),
        deps,
      );

      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Your package isn't here yet — a neighbour is collecting it for you. I'll DM you the moment they hand it over.",
      );
    });

    it("matched RR + getResidentByPlatformId throws → falls back to volunteer-name-free phrasing (no regression)", async () => {
      const resident = recipientResident("de");
      const { deps, sendDirectMessage, confirmPickup, sendToAsh } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [matchedRequestForDiego()],
        residentByPlatformIdError: new Error("redis hiccup"),
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(confirmPickup).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Dein Paket ist noch nicht da – ein:e Nachbar:in nimmt es für dich an. Ich melde mich, sobald es übergeben wird.",
      );
    });

    it("matched RR with null volunteerResidentId → no getResident call, generic phrasing", async () => {
      // Edge case: a matched RR shouldn't have a null volunteer in
      // production (the `acceptReceptionRequest` flip always populates
      // it), but a stale record from a partially-failed earlier write
      // could. The channel must still produce a coherent DM.
      const resident = recipientResident("de");
      const { deps, sendDirectMessage, getResidentByPlatformId } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [
          matchedRequestForDiego({ volunteerResidentId: null }),
        ],
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(getResidentByPlatformId).not.toHaveBeenCalled();
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Dein Paket ist noch nicht da – ein:e Nachbar:in nimmt es für dich an. Ich melde mich, sobald es übergeben wird.",
      );
    });

    it("listMatchedReceptionRequestsForRequester throws → falls back to pre-#122 'no open packages' DM (no regression)", async () => {
      const resident = recipientResident("de");
      const { deps, sendDirectMessage, sendToAsh, confirmPickup } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequesterError: new Error("redis down"),
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(confirmPickup).not.toHaveBeenCalled();
      expect(sendToAsh).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Du hast aktuell kein offenes Paket bei mir.",
      );
    });

    it("0 open packages AND 0 matched RRs → pre-#122 'no open packages' DM stays verbatim (no regression)", async () => {
      const resident = recipientResident("de");
      const {
        deps,
        sendDirectMessage,
        listMatchedReceptionRequestsForRequester,
        getResidentByPlatformId,
      } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [],
        matchedReceptionRequestsForRequester: [],
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      // Sanity: the new lookup ran (we check before falling back).
      expect(listMatchedReceptionRequestsForRequester).toHaveBeenCalledTimes(1);
      // No volunteer lookup because there's no matched RR.
      expect(getResidentByPlatformId).not.toHaveBeenCalled();
      expect(sendDirectMessage).toHaveBeenCalledTimes(1);
      expect(sendDirectMessage.mock.calls[0]![1]).toBe(
        "Du hast aktuell kein offenes Paket bei mir.",
      );
    });

    it("1 held Package present → existing 1-match confirmPickup path stays untouched (no new lookup)", async () => {
      // Regression pin: when the caller HAS a held Package, the channel
      // must not call listMatchedReceptionRequestsForRequester at all —
      // the new lookup is exclusive to the 0-package branch.
      const resident = recipientResident("de");
      const {
        deps,
        confirmPickup,
        listMatchedReceptionRequestsForRequester,
        getResidentByPlatformId,
      } = buildDeps({
        classification: {
          kind: "pickup-confirmation",
          absenceSignal: false,
          confidence: "high",
          reason: "explicit pickup phrasing",
        },
        registeredResident: resident,
        openPackagesForRecipient: [heldPackage("pkg_42")],
      });

      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 200,
            text: "Hab abgeholt",
            fromUserId: 200,
            languageCode: "de",
          }),
        ),
        deps,
      );

      expect(confirmPickup).toHaveBeenCalledTimes(1);
      expect(listMatchedReceptionRequestsForRequester).not.toHaveBeenCalled();
      expect(getResidentByPlatformId).not.toHaveBeenCalled();
    });
  });

  it("2+ open packages → sends disambiguation DM pointing at per-package DM above, does NOT call confirmPickup (v2.1 #115)", async () => {
    const resident = recipientResident("de");
    const { deps, sendToAsh, sendDirectMessage, confirmPickup } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipient: [
        heldPackage("pkg_42"),
        heldPackage("pkg_43"),
      ],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Hab abgeholt",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(confirmPickup).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Du hast mehrere offene Pakete. Bitte tippe [Abgeholt] in der entsprechenden DM oben — ich habe dir für jedes Paket eine eigene Nachricht geschickt.",
    );
  });

  it("confirmPickup throws PICKUP_ALREADY_DONE → sends 'already picked up' DM (idempotent), no retry", async () => {
    const resident = recipientResident("de");
    const alreadyDoneErr: Error & { code?: string } = Object.assign(
      new Error("already done"),
      { code: "PICKUP_ALREADY_DONE" },
    );
    const { deps, sendToAsh, sendDirectMessage } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipient: [heldPackage("pkg_42")],
      confirmPickupError: alreadyDoneErr,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Hab abgeholt",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Dieses Paket wurde schon abgeholt.",
    );
  });

  it("confirmPickup throws generic error → sends retry DM, no agent fallthrough", async () => {
    const resident = recipientResident("de");
    const { deps, sendToAsh, sendDirectMessage } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipient: [heldPackage("pkg_42")],
      confirmPickupError: new Error("redis down"),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Hab abgeholt",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Etwas ist schiefgelaufen. Bitte gleich nochmal versuchen.",
    );
  });

  it("listOpenPackagesForRecipient throws → sends retry DM, no agent fallthrough", async () => {
    const resident = recipientResident("de");
    const { deps, sendToAsh, sendDirectMessage, confirmPickup } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: resident,
      openPackagesForRecipientError: new Error("redis down"),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Hab abgeholt",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(confirmPickup).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Etwas ist schiefgelaufen. Bitte gleich nochmal versuchen.",
    );
  });

  it("unregistered caller → falls through to agent with raw text (no confirmPickup, no list)", async () => {
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      confirmPickup,
      listOpenPackagesForRecipient,
    } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "high",
        reason: "explicit pickup phrasing",
      },
      registeredResident: null,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "Hab abgeholt",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listOpenPackagesForRecipient).not.toHaveBeenCalled();
    expect(confirmPickup).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    // The agent gets the raw text; it'll typically ask the user to /register.
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    expect(sendToAsh.mock.calls[0]![0]).toBe("Hab abgeholt");
  });

  it("medium-confidence pickup-confirmation → fallthrough to agent (high-conf gate)", async () => {
    const resident = recipientResident("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      confirmPickup,
      listOpenPackagesForRecipient,
    } = buildDeps({
      classification: {
        kind: "pickup-confirmation",
        absenceSignal: false,
        confidence: "medium",
        reason: "fuzzy closing language",
      },
      registeredResident: resident,
      openPackagesForRecipient: [heldPackage("pkg_42")],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "ich habe das",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listOpenPackagesForRecipient).not.toHaveBeenCalled();
    expect(confirmPickup).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    expect(sendToAsh.mock.calls[0]![0]).toBe("ich habe das");
  });

  it("classifier returns kind='registration' or 'other' → does NOT call list/confirm even at high confidence", async () => {
    const resident = recipientResident("de");
    const { deps, confirmPickup, listOpenPackagesForRecipient } = buildDeps({
      classification: {
        kind: "registration",
        absenceSignal: false,
        confidence: "high",
        reason: "/register prefix",
      },
      registeredResident: resident,
      openPackagesForRecipient: [heldPackage("pkg_42")],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "/register Marlene, Methfesselstraße 88",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listOpenPackagesForRecipient).not.toHaveBeenCalled();
    expect(confirmPickup).not.toHaveBeenCalled();
  });

  it("does NOT trigger pickup routing on a high-confidence flow2-reception classification", async () => {
    const resident = recipientResident("de");
    const {
      deps,
      confirmPickup,
      listOpenPackagesForRecipient,
      createReceptionRequest,
    } = buildDeps({
      classification: {
        kind: "flow2-reception",
        absenceSignal: true,
        carrier: "DHL",
        confidence: "high",
        reason: "absence + DHL",
      },
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 200,
          text: "Ich erwarte DHL und bin nicht zu Hause",
          fromUserId: 200,
          languageCode: "de",
        }),
      ),
      deps,
    );

    // Pickup deps untouched; the Flow 2 path took over instead.
    expect(listOpenPackagesForRecipient).not.toHaveBeenCalled();
    expect(confirmPickup).not.toHaveBeenCalled();
    expect(createReceptionRequest).toHaveBeenCalledTimes(1);
  });
});

describe("processInboundTelegramUpdate — DM-text Flow 2 → Flow 1 volunteer early-arrival (v2.1 #121)", () => {
  // The Diego ↔ Melanie scenario from the issue body. Diego posted a
  // Flow 2 request; Melanie tapped [Ich kann helfen] and is now the
  // matched volunteer. The bot has a `matched` RR with
  // requester=Diego (resident "100"), volunteer=Melanie (resident
  // "300"). Melanie DMs "Hab das Paket schon" / "got it - thanks!".
  function melanieVolunteer(language: string | undefined = "de"): Resident {
    return {
      id: "300",
      name: "Melanie Torena",
      street: "Methfesselstraße",
      houseNumber: "44",
      platformId: "300",
      platform: "telegram",
      language,
      availabilityPatterns: [],
      registeredAt: Date.now(),
      source: "explicit",
      confirmed: true,
    };
  }

  function matchedRequestRequesterDiegoVolunteerMelanie(
    overrides: Partial<ReceptionRequest> = {},
  ): ReceptionRequest {
    return {
      id: "req_mpmac3o7_sb0isv",
      streetId: "Methfesselstraße",
      requesterResidentId: "100", // Diego (the requester)
      requesterName: "Diego de Miguel",
      requesterHouseNumber: "69",
      carrier: "DHL",
      expectedAt: null,
      volunteerResidentId: "300", // Melanie (the volunteer / caller)
      volunteerAvailability: null,
      status: "matched",
      createdAt: Date.now() - 60_000,
      respondedAt: Date.now() - 30_000,
      ...overrides,
    };
  }

  function registerPackageResultForDiegoFromMelanie(
    overrides?: Partial<RegisterPackageResult>,
  ): RegisterPackageResult {
    return {
      package: {
        id: "pkg_new",
        streetId: "Methfesselstraße",
        recipientResidentId: "100",
        recipientName: "Diego de Miguel",
        recipientHouseNumber: "69",
        holderResidentId: "300",
        carrier: "DHL",
        status: "held",
        receivedAt: Date.now(),
        pickedUpAt: null,
        reminded: false,
        receptionRequestId: "req_mpmac3o7_sb0isv",
      } satisfies Package,
      holder: {
        id: "300",
        platformId: "300",
        name: "Melanie Torena",
        houseNumber: "44",
        floor: null,
        buzzerName: null,
        language: "de",
      },
      recipientResolution: {
        kind: "resident",
        resident: {
          id: "100",
          name: "Diego de Miguel",
          houseNumber: "69",
          language: "de",
          floor: null,
          buzzerName: null,
        },
      },
      receptionRequestFulfilled: {
        requestId: "req_mpmac3o7_sb0isv",
        requesterResidentId: "100",
        previousStatus: "matched",
      },
      ...overrides,
    };
  }

  it("happy path (DE): 1 matched RR as volunteer → registers Package + DMs recipient with [Abgeholt] + DMs volunteer ack, no agent, no group", async () => {
    const volunteer = melanieVolunteer("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      registerPackage,
      listMatchedReceptionRequestsForVolunteer,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        carrier: "DHL",
        confidence: "high",
        reason: "early-arrival + possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
      registerPackageResult: registerPackageResultForDiegoFromMelanie(),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listMatchedReceptionRequestsForVolunteer).toHaveBeenCalledTimes(1);
    expect(listMatchedReceptionRequestsForVolunteer).toHaveBeenCalledWith(
      volunteer,
    );
    expect(registerPackage).toHaveBeenCalledTimes(1);
    expect(registerPackage).toHaveBeenCalledWith(volunteer, {
      recipientName: "Diego de Miguel",
      recipientHouseNumber: "69",
      carrier: "DHL",
    });
    expect(sendToAsh).not.toHaveBeenCalled();

    // Two DMs: recipient (Diego, chatId=100) with [Abgeholt] keyboard,
    // and volunteer (Melanie, chatId=300) with the German ack.
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);

    // Recipient DM: text + keyboard.
    const recipientCall = sendDirectMessage.mock.calls[0]!;
    expect(recipientCall[0]).toBe(100);
    expect(recipientCall[1]).toBe(
      "Melanie Torena hat das Paket abgeholt – du kannst es jetzt abholen.",
    );
    // 4th arg is the keyboard.
    expect(recipientCall[3]).toEqual({
      inline_keyboard: [
        [
          {
            text: "Abgeholt",
            callback_data: "confirm_pickup:pkg_new",
          },
        ],
      ],
    });

    // Volunteer ack DM (German default).
    const volunteerCall = sendDirectMessage.mock.calls[1]!;
    expect(volunteerCall[0]).toBe(300);
    expect(volunteerCall[1]).toBe(
      "Alles klar — Diego de Miguel wurde benachrichtigt.",
    );
  });

  it("English volunteer: 1 matched RR → English recipient + volunteer DMs (recipient language follows recipientResolution.resident.language)", async () => {
    const volunteer = melanieVolunteer("en");
    const { deps, sendDirectMessage } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
      registerPackageResult: registerPackageResultForDiegoFromMelanie({
        recipientResolution: {
          kind: "resident",
          resident: {
            id: "100",
            name: "Diego de Miguel",
            houseNumber: "69",
            language: "en",
            floor: null,
            buzzerName: null,
          },
        },
      }),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "got it - thanks!",
          fromUserId: 300,
          languageCode: "en",
        }),
      ),
      deps,
    );

    // Recipient DM in English (their stored language).
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Melanie Torena has picked up the package — you can now pick it up.",
    );
    // Volunteer ack DM in English (their stored language).
    expect(sendDirectMessage.mock.calls[1]![1]).toBe(
      "Got it — Diego de Miguel has been notified.",
    );
  });

  it("0 matched RRs as volunteer → fallthrough to agent (no register, no DMs)", async () => {
    const volunteer = melanieVolunteer("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      registerPackage,
      listMatchedReceptionRequestsForVolunteer,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listMatchedReceptionRequestsForVolunteer).toHaveBeenCalledTimes(1);
    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    // Fell through to the agent with the raw text.
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("2+ matched RRs as volunteer → fallthrough to agent (no register, no DMs)", async () => {
    const volunteer = melanieVolunteer("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      registerPackage,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie({ id: "req_A" }),
        matchedRequestRequesterDiegoVolunteerMelanie({
          id: "req_B",
          requesterResidentId: "999",
          requesterName: "Other Neighbour",
          requesterHouseNumber: "22",
        }),
      ],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("unregistered caller → fallthrough to agent (no list, no register)", async () => {
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      registerPackage,
      listMatchedReceptionRequestsForVolunteer,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: null,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(listMatchedReceptionRequestsForVolunteer).not.toHaveBeenCalled();
    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("medium-confidence flow2-volunteer-early-arrival → fallthrough to agent (high-conf gate)", async () => {
    const volunteer = melanieVolunteer("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      registerPackage,
      listMatchedReceptionRequestsForVolunteer,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "medium",
        reason: "fuzzy possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "es kam an",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    // Medium → no deterministic route fires; falls through to agent.
    expect(listMatchedReceptionRequestsForVolunteer).not.toHaveBeenCalled();
    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("listMatchedReceptionRequestsForVolunteer throws → fallthrough to agent (no register, no DM)", async () => {
    const volunteer = melanieVolunteer("de");
    const { deps, sendToAsh, sendDirectMessage, registerPackage } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteerError: new Error("redis hiccup"),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("registerPackage throws → sends retry DM to volunteer, NO agent invocation (handled)", async () => {
    const volunteer = melanieVolunteer("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      registerPackage,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
      registerPackageError: new Error("redis hiccup on setPackage"),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).toHaveBeenCalledTimes(1);
    expect(sendToAsh).not.toHaveBeenCalled();
    // Retry DM to the volunteer (chatId=300, German).
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![0]).toBe(300);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Etwas ist schiefgelaufen. Bitte gleich nochmal versuchen.",
    );
  });

  it("carrier from classifier when present takes precedence over the RR's carrier", async () => {
    const volunteer = melanieVolunteer("de");
    const { deps, registerPackage } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        carrier: "Hermes",
        confidence: "high",
        reason: "possession + Hermes carrier",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie({ carrier: "DHL" }),
      ],
      registerPackageResult: registerPackageResultForDiegoFromMelanie(),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Hermes-Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).toHaveBeenCalledWith(volunteer, {
      recipientName: "Diego de Miguel",
      recipientHouseNumber: "69",
      carrier: "Hermes",
    });
  });

  it("carrier falls back to RR.carrier when classifier carrier is omitted", async () => {
    const volunteer = melanieVolunteer("de");
    const { deps, registerPackage } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie({ carrier: "DHL" }),
      ],
      registerPackageResult: registerPackageResultForDiegoFromMelanie(),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).toHaveBeenCalledWith(volunteer, {
      recipientName: "Diego de Miguel",
      recipientHouseNumber: "69",
      carrier: "DHL",
    });
  });

  it("recipient DM throws → Package + ack DM still happen (best-effort recipient delivery)", async () => {
    const volunteer = melanieVolunteer("de");
    const sendDmMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error("recipient blocked")))
      .mockResolvedValue(undefined);
    const { deps, registerPackage, sendToAsh } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
      registerPackageResult: registerPackageResultForDiegoFromMelanie(),
    });
    // Replace the deps' sendDirectMessage with our mock that rejects
    // the first call (recipient) and resolves the second (volunteer ack).
    (deps as unknown as { sendDirectMessage: typeof sendDmMock }).sendDirectMessage =
      sendDmMock;

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).toHaveBeenCalledTimes(1);
    expect(sendToAsh).not.toHaveBeenCalled();
    // Two attempts: recipient (rejected, swallowed) + volunteer ack.
    expect(sendDmMock).toHaveBeenCalledTimes(2);
    // Volunteer ack still sent.
    expect(sendDmMock.mock.calls[1]![0]).toBe(300);
    expect(sendDmMock.mock.calls[1]![1]).toBe(
      "Alles klar — Diego de Miguel wurde benachrichtigt.",
    );
  });

  it("kind 'flow2-volunteer-early-arrival' does NOT trigger the pickup-confirmation path or the flow2-reception path", async () => {
    const volunteer = melanieVolunteer("de");
    const {
      deps,
      confirmPickup,
      createReceptionRequest,
      listOpenPackagesForRecipient,
    } = buildDeps({
      classification: {
        kind: "flow2-volunteer-early-arrival",
        absenceSignal: false,
        confidence: "high",
        reason: "possession",
      },
      registeredResident: volunteer,
      matchedReceptionRequestsForVolunteer: [
        matchedRequestRequesterDiegoVolunteerMelanie(),
      ],
      registerPackageResult: registerPackageResultForDiegoFromMelanie(),
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 300,
          text: "Hab das Paket schon",
          fromUserId: 300,
          languageCode: "de",
        }),
      ),
      deps,
    );

    // Regression pin: the dispatch keys on `kind`, so neither sibling
    // route should fire.
    expect(confirmPickup).not.toHaveBeenCalled();
    expect(listOpenPackagesForRecipient).not.toHaveBeenCalled();
    expect(createReceptionRequest).not.toHaveBeenCalled();
  });
});

describe("processInboundTelegramUpdate — /receive slash command (v2.1 Slice 2, #87)", () => {
  function dmRegisteredResident(language = "de"): Resident {
    return {
      id: "patricia",
      name: "Patricia Höfer",
      street: "Methfesselstraße",
      houseNumber: "90",
      platformId: "patricia",
      platform: "telegram",
      language,
      availabilityPatterns: [],
      registeredAt: Date.now(),
      source: "explicit",
      confirmed: true,
    };
  }

  it("bare /receive writes a request with no carrier or window and sends the German ack DM (no agent invocation, #100)", async () => {
    const resident = dmRegisteredResident("de");
    const {
      deps,
      sendToAsh,
      sendDirectMessage,
      waitUntil,
      createReceptionRequest,
    } = buildDeps({ registeredResident: resident });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "/receive",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(createReceptionRequest).toHaveBeenCalledTimes(1);
    const [caller, input] = createReceptionRequest.mock.calls[0]!;
    expect(caller).toBe(resident);
    // Bare /receive → empty input → createReceptionRequest renders the
    // sparse card "📦 Paket erwartet. Kann jemand annehmen?".
    expect(input).toEqual({
      carrier: undefined,
      expectedDate: undefined,
      expectedWindowStartAt: undefined,
      expectedWindowEndAt: undefined,
    });

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("`/receive DHL morgen 14-16` parses args and forwards them to createReceptionRequest", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, sendToAsh, sendDirectMessage, createReceptionRequest } =
      buildDeps({ registeredResident: resident });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "/receive DHL morgen 14-16",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(createReceptionRequest).toHaveBeenCalledTimes(1);
    const [caller, input] = createReceptionRequest.mock.calls[0]!;
    expect(caller).toBe(resident);
    expect(input.carrier).toBe("DHL");
    expect(input.expectedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof input.expectedWindowStartAt).toBe("number");
    expect(typeof input.expectedWindowEndAt).toBe("number");
    // The window is exactly 2 hours.
    expect(input.expectedWindowEndAt - input.expectedWindowStartAt).toBe(
      2 * 60 * 60 * 1000,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
  });

  it("uses the resident's stored language for the ack DM (tr)", async () => {
    const resident = dmRegisteredResident("tr");
    const { deps, sendToAsh, sendDirectMessage } = buildDeps({
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "/receive",
          fromUserId: 99,
          languageCode: "tr",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage.mock.calls[0]![1]).toBe(
      "Gruba sordum — biri yanıt verince haber veririm.",
    );
  });

  it("does NOT call the classifier when the inbound is /receive", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, classifyDmIntent } = buildDeps({
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "/receive DHL",
          fromUserId: 99,
        }),
      ),
      deps,
    );

    expect(classifyDmIntent).not.toHaveBeenCalled();
  });

  it("falls through to raw text when the caller is unregistered (no createReceptionRequest)", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      registeredResident: null,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "/receive DHL", fromUserId: 99 }),
      ),
      deps,
    );

    expect(createReceptionRequest).not.toHaveBeenCalled();
    const [message] = sendToAsh.mock.calls[0]!;
    // The agent receives the raw /receive text and will typically ask
    // the user to /register first.
    expect(message).toBe("/receive DHL");
  });

  it("falls through to raw text when createReceptionRequest throws (Redis hiccup)", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      registeredResident: resident,
    });
    createReceptionRequest.mockRejectedValueOnce(new Error("redis down"));

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "/receive DHL morgen", fromUserId: 99 }),
      ),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toBe("/receive DHL morgen");
  });

  it("does NOT trigger on /receivex (no word boundary) — classifier runs instead", async () => {
    const { deps, classifyDmIntent, createReceptionRequest } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "/receivex DHL", fromUserId: 99 }),
      ),
      deps,
    );

    expect(classifyDmIntent).toHaveBeenCalledTimes(1);
    expect(createReceptionRequest).not.toHaveBeenCalled();
  });

  it("does NOT trigger on /receive in a group chat (group is not a Flow 2 entry point)", async () => {
    // v2.1 #106 Slice 1: group text now routes through the Flow 1
    // classifier instead of falling straight to the agent. `/receive`
    // in a group is off-topic (the classifier returns
    // `isPackageRegistration: false` by default in this test setup),
    // so the channel stays silent — both `createReceptionRequest`
    // (Flow 2) and `sendToAsh` (agent) are bypassed.
    const { deps, createReceptionRequest, sendToAsh } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          text: "/receive DHL morgen",
          chat: { id: -100123, type: "supergroup" },
          from: { id: 99, is_bot: false, first_name: "T" },
        },
      }),
      deps,
    );

    expect(createReceptionRequest).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("accepts /receive followed by a bot @-mention", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, createReceptionRequest } = buildDeps({
      registeredResident: resident,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 42,
          text: "/receive@DropMate_bot Hermes morgen",
          fromUserId: 99,
        }),
      ),
      deps,
    );

    expect(createReceptionRequest).toHaveBeenCalledTimes(1);
    const [, input] = createReceptionRequest.mock.calls[0]!;
    expect(input.carrier).toBe("Hermes");
  });
});

// v2.1 #100: the `[FLOW_2 DONE]` synthetic was deleted entirely along
// with the agent's role in the Flow 2 success path. The directive-shape
// constraints the previous "FLOW_2 DONE synthetic shape" describe block
// pinned (no carrier, no emoji, embedded example) are no longer
// necessary — the channel sends the deterministic ack DM itself via
// `buildFlow2AckDm`. The known-good per-language ack strings are
// asserted in `flow-2-dms.test.ts` and the per-language outcome of each
// Flow 2 entry path is asserted above (DM photo + classifier +
// /receive describe blocks).

describe("processInboundTelegramUpdate — registration (v2.1 #97 — channel-deterministic DM onboarding)", () => {
  // Live trace 2026-05-22 (#97): a fresh user DM'd
  // `/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss Links`
  // and received 10 bot messages — a freely-generated welcome wall, a
  // trilingual /language brochure, AND a Flow 2 misfire ("Habe in der
  // Gruppe gefragt…") against a registration message that never asked
  // for a reception request. Fix: pull the registration decision out
  // of the model the same way Slice 1 (#86) pulled Flow 2 out. The
  // channel writes the Resident + sends ONE deterministic confirmation
  // DM. The agent never runs. These cases pin that contract.

  it("`/register` slash with full args → one DM, no agent invocation, no group post", async () => {
    const { deps, sendToAsh, sendDirectMessage, registerResident, waitUntil } =
      buildDeps();

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss Links",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    // sendToAsh NEVER called — the agent is structurally bypassed.
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    // Lib write was driven from the channel.
    expect(registerResident).toHaveBeenCalledTimes(1);
    expect(registerResident.mock.calls[0]![0]).toEqual({
      name: "Diego de Miguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      floor: "Erdgeschoss",
      buzzerName: "Links",
      platformId: "99",
      telegramLanguageCode: "de",
    });
    // Exactly ONE DM — the confirmation. No welcome wall.
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendDirectMessage.mock.calls[0]!;
    expect(chatId).toBe(99);
    expect(text).toBe(
      "Vielen Dank, Diego de Miguel! Du bist jetzt unter Lutterothstrasse 69, Erdgeschoss Links registriert.",
    );
  });

  it("`/register` slash with a comma between name and address parses identically", async () => {
    const { deps, registerResident, sendToAsh } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/register Anna-Sophie Meyer, Methfesselstraße 92",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(registerResident).toHaveBeenCalledTimes(1);
    expect(registerResident.mock.calls[0]![0]).toMatchObject({
      name: "Anna-Sophie Meyer",
      street: "Methfesselstraße",
      houseNumber: "92",
    });
  });

  it("free-text `Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links` is handled deterministically (no agent)", async () => {
    const { deps, sendToAsh, registerResident, classifyDmIntent } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "Diego de Miguel, Lutterothstrasse 69 Erdgeschoss Links",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    // The classifier is also bypassed — we don't want to burn a Flow 2
    // classification on a registration inbound (the misfire that
    // produced the live-trace "Habe in der Gruppe gefragt …" duplicates).
    expect(classifyDmIntent).not.toHaveBeenCalled();
    expect(registerResident).toHaveBeenCalledTimes(1);
  });

  it("falls through to the classifier when free-text does not match the registration shape", async () => {
    const { deps, sendToAsh, registerResident, classifyDmIntent } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "Wo ist mein Paket?",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerResident).not.toHaveBeenCalled();
    // Classifier runs (and returns kind:"other" by default in this
    // suite), so the agent ultimately gets the raw text.
    expect(classifyDmIntent).toHaveBeenCalledTimes(1);
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("bare `/register` with no args → usage-hint DM, no agent invocation, no Resident write", async () => {
    const { deps, sendToAsh, sendDirectMessage, registerResident } = buildDeps();

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/register",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(registerResident).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendDirectMessage.mock.calls[0]!;
    expect(text).toContain("/register");
    // German usage hint by default.
    expect(text).toContain("<Name>");
  });

  it("`/start` (Telegram tap-to-start) → usage-hint DM, no agent invocation, no Resident write", async () => {
    const { deps, sendToAsh, sendDirectMessage, registerResident } = buildDeps();

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/start",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(registerResident).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendDirectMessage.mock.calls[0]!;
    expect(text).toContain("/register");
    expect(text).toContain("<Name>");
  });

  it("`/start <deeplink-token>` is also caught — the token is ignored", async () => {
    const { deps, sendToAsh, sendDirectMessage } = buildDeps();

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/start ref_abc123",
          fromUserId: 99,
          languageCode: "en",
        }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(sendToAsh).not.toHaveBeenCalled();
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [, text] = sendDirectMessage.mock.calls[0]!;
    // English usage hint.
    expect(text).toContain("Please write: /register");
  });

  it("uses the resident's stored language for the confirmation DM after re-registration", async () => {
    // Re-registration: lib returns updated:true with the existing
    // resident.language. Confirmation DM should render in that
    // preserved language regardless of telegram's current languageCode.
    const { deps, sendDirectMessage } = buildDeps({
      registerResult: {
        resident: {
          id: "99",
          name: "Diego de Miguel",
          street: "Lutterothstrasse",
          houseNumber: "69",
          floor: "Erdgeschoss",
          platformId: "99",
          platform: "telegram",
          language: "en", // ← stored from earlier DM
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        },
        updated: true,
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss",
          fromUserId: 99,
          languageCode: "de", // ← ignored; resident.language=en wins
        }),
      ),
      deps,
    );

    const [, text] = sendDirectMessage.mock.calls[0]!;
    expect(text).toBe(
      "Thanks, Diego de Miguel! You're registered at Lutterothstrasse 69, Erdgeschoss.",
    );
  });

  it("falls back to telegram languageCode when resident.language is unset", async () => {
    const { deps, sendDirectMessage } = buildDeps({
      registerResult: {
        resident: {
          id: "99",
          name: "Diego de Miguel",
          street: "Lutterothstrasse",
          houseNumber: "69",
          platformId: "99",
          platform: "telegram",
          // language deliberately omitted
          availabilityPatterns: [],
          registeredAt: 1716000000000,
          source: "explicit",
          confirmed: true,
        },
        updated: false,
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/register Diego de Miguel Lutterothstrasse 69",
          fromUserId: 99,
          languageCode: "tr",
        }),
      ),
      deps,
    );

    const [, text] = sendDirectMessage.mock.calls[0]!;
    expect(text).toContain("Teşekkürler");
    expect(text).toContain("kaydedildin");
  });

  it("falls through to the agent when registerResident throws (Redis hiccup)", async () => {
    const { deps, sendToAsh, registerResident, sendDirectMessage } = buildDeps();
    registerResident.mockRejectedValueOnce(new Error("redis down"));

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 99,
          text: "/register Diego de Miguel Lutterothstrasse 69 Erdgeschoss",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    // Returns 204 from the agent path (sendToAsh is mocked).
    expect(res.status).toBe(204);
    // Lib was attempted.
    expect(registerResident).toHaveBeenCalledTimes(1);
    // The hiccup fell through to the agent — the user gets *some*
    // response even when Redis is down.
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    // No deterministic confirmation DM — the lib write failed, so we
    // cannot render the resident-specific confirmation. The agent's
    // outbound drain handles the user-facing apology.
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  it("group `/register` does NOT fire the channel-deterministic registration path", async () => {
    // v2.1 #106 Slice 1: post-#106 a group `/register` goes through
    // the Flow 1 classifier (default mock verdict: not a package
    // registration → silent). Both `registerResident` (Slice 0
    // registration path) and `sendToAsh` (agent) are bypassed —
    // registration is still a 1:1 DM-only onboarding flow, just now
    // the group text path is also fully channel-handled.
    const { deps, sendToAsh, registerResident } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          text: "/register Diego de Miguel Lutterothstrasse 69",
          chat: { id: -100, type: "supergroup" },
          from: { id: 99, is_bot: false, first_name: "T", language_code: "de" },
        },
      }),
      deps,
    );

    expect(registerResident).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("confirmation DM language coverage — en/es/tr also render in their locale", async () => {
    async function runFor(language: "en" | "es" | "tr") {
      const { deps, sendDirectMessage } = buildDeps({
        registerResult: {
          resident: {
            id: "99",
            name: "Diego de Miguel",
            street: "Lutterothstrasse",
            houseNumber: "69",
            platformId: "99",
            platform: "telegram",
            language,
            availabilityPatterns: [],
            registeredAt: 0,
            source: "explicit",
            confirmed: true,
          },
          updated: false,
        },
      });
      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 99,
            text: "/register Diego de Miguel Lutterothstrasse 69",
            fromUserId: 99,
            languageCode: language,
          }),
        ),
        deps,
      );
      const [, text] = sendDirectMessage.mock.calls[0]!;
      return text as string;
    }

    expect(await runFor("en")).toBe(
      "Thanks, Diego de Miguel! You're registered at Lutterothstrasse 69.",
    );
    expect(await runFor("es")).toBe(
      "Gracias, Diego de Miguel! Estás registrado en Lutterothstrasse 69.",
    );
    expect(await runFor("tr")).toBe(
      "Teşekkürler, Diego de Miguel! Lutterothstrasse 69 adresine kaydedildin.",
    );
  });

  it("usage-hint language coverage — en/es/tr also render in their locale", async () => {
    async function runFor(language: "en" | "es" | "tr") {
      const { deps, sendDirectMessage } = buildDeps();
      await processInboundTelegramUpdate(
        makeRequest(
          dmUpdate({
            chatId: 99,
            text: "/register",
            fromUserId: 99,
            languageCode: language,
          }),
        ),
        deps,
      );
      const [, text] = sendDirectMessage.mock.calls[0]!;
      return text as string;
    }

    expect(await runFor("en")).toContain("Please write");
    expect(await runFor("es")).toContain("Por favor escribe");
    expect(await runFor("tr")).toContain("Lütfen şöyle yaz");
  });
});

describe("processInboundTelegramUpdate — setTriggerAttribute (v2.1 #99)", () => {
  // The channel sets the inbound shape on the active OTel span BEFORE
  // every `sendToAsh` call so Vercel's Agent Runs view can populate the
  // Trigger column. The dep is optional (so existing tests / the spike
  // can opt out by omitting it); when supplied the factory wires a real
  // implementation that delegates to `setTelegramTriggerAttribute`.
  //
  // The values describe what the channel handed to the agent — not the
  // raw inbound shape — because v2.1's channel-deterministic routes
  // intercept many Flow 2 / registration / volunteer-accept inbounds
  // before they reach the agent. Only surfaces that still call
  // `sendToAsh` get attribution.

  it("free-text DM (classifier fallthrough) → telegram.text-dm", async () => {
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 1, text: "Hallo", fromUserId: 99 })),
      deps,
    );

    expect(sendToAsh).toHaveBeenCalledTimes(1);
    expect(setTriggerAttribute).toHaveBeenCalledWith("telegram.text-dm");
    // Attribute set BEFORE the agent runs so it lands on the active
    // span before Ash opens its `ash.turn` child.
    expect(setTriggerAttribute.mock.invocationCallOrder[0]!).toBeLessThan(
      sendToAsh.mock.invocationCallOrder[0]!,
    );
  });

  it("group text message → channel-deterministic; agent is NOT invoked on the default-silent classifier verdict (v2.1 #106)", async () => {
    // v2.1 #106 Slice 1: group text always goes through the Flow 1
    // classifier first. With the default `isPackageRegistration:
    // false` verdict the channel stays silent — `sendToAsh` is NOT
    // called, and `setTriggerAttribute("telegram.group")` is NOT
    // set (the attribute is only stamped on inbounds the channel
    // hands to the agent, per #99). The previous "every group text
    // becomes a `telegram.group` Agent Runs row" behaviour is gone
    // and that's the point — group chat noise no longer burns Ash
    // turns.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps();

    const groupUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: "Hallo Gruppe",
        chat: { id: -100, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T", language_code: "de" },
      },
    };

    await processInboundTelegramUpdate(makeRequest(groupUpdate), deps);

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("group photo (Flow 1 channel-deterministic, v2.1 #107) → handled, no agent invocation", async () => {
    // v2.1 #107 Slice 2 inverted the prior invariant: group photos
    // are now fully channel-deterministic on the happy path. On
    // high-confidence parse_label + registered-resident recipient,
    // `sendToAsh` is NEVER called, so `setTriggerAttribute` is NEVER
    // set either. Regression: ensures channel-deterministic paths
    // don't pollute the dashboard with phantom Trigger entries on
    // rows that have no turns.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps({
      registeredResident: {
        id: "99",
        name: "Diego",
        street: "Lutterothstrasse",
        houseNumber: "69",
        platformId: "99",
        platform: "telegram",
        language: "de",
        availabilityPatterns: [],
        registeredAt: 1716000000000,
        source: "explicit",
        confirmed: true,
      },
    });

    const photoUpdate = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -100, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [
          { file_id: "small", file_size: 100, width: 90, height: 90 },
          { file_id: "large", file_size: 5000, width: 1280, height: 1280 },
        ],
      },
    };

    await processInboundTelegramUpdate(makeRequest(photoUpdate), deps);

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("DM photo recovery fallthrough (low-confidence parse handled by channel) → handled, no agent invocation", async () => {
    // DM photo low-confidence is handled by the channel deterministically
    // per #100 — `sendToAsh` is NEVER called, so the trigger attribute
    // is NEVER set. Regression: ensures channel-deterministic paths
    // don't pollute the dashboard with phantom Trigger entries on rows
    // that have no turns.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps({
      parsedTrackingPage: {
        carrier: "DHL",
        confidence: "low",
        reason: "blurry receipt",
      },
      registeredResident: {
        id: "99",
        name: "Diego",
        street: "Lutterothstrasse",
        houseNumber: "69",
        platformId: "99",
        platform: "telegram",
        language: "de",
        availabilityPatterns: [],
        registeredAt: 1716000000000,
        source: "explicit",
        confirmed: true,
      },
    });

    const dmPhoto = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 99, is_bot: false, first_name: "T", language_code: "de" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(dmPhoto), deps);

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("/receive slash fallthrough (unregistered caller) → telegram.slash-receive", async () => {
    // Unregistered caller on /receive → channel falls through to the
    // agent so the Onboarding stanza can ask them to /register first.
    // Trigger attribute should describe what the channel handed off.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps({
      registeredResident: null,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 1,
          text: "/receive DHL morgen 14-16",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(sendToAsh).toHaveBeenCalledTimes(1);
    expect(setTriggerAttribute).toHaveBeenCalledWith("telegram.slash-receive");
  });

  it("callback_query confirm_pickup → NOT attributed (v2.1 #108 — channel handles deterministically)", async () => {
    // The pre-#108 surface attributed `telegram.callback-confirm-pickup`
    // because the tap fell through to `sendToAsh`. After #108 the
    // channel handles the tap end-to-end and never calls `sendToAsh`
    // on this path — so there is no `ash.turn` row to attribute,
    // and the trigger attribute must not be set.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps({
      registeredResident: {
        id: "99",
        name: "Tapper",
        street: "Methfesselstraße",
        houseNumber: "88",
        platformId: "99",
        platform: "telegram",
        language: "de",
        availabilityPatterns: [],
        registeredAt: 1716000000000,
        source: "explicit",
        confirmed: true,
      } satisfies Resident,
    });

    const cbUpdate = {
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "T" },
        message: {
          message_id: 5,
          chat: { id: -100, type: "supergroup" },
        },
        chat_instance: "chat-instance-1",
        data: "confirm_pickup:pkg_42",
      },
    };

    await processInboundTelegramUpdate(makeRequest(cbUpdate), deps);

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("callback_query non-confirm-pickup actions → telegram.callback (generic bucket)", async () => {
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps();

    const cbUpdate = {
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 99, is_bot: false, first_name: "T" },
        message: {
          message_id: 5,
          chat: { id: 1, type: "private" },
        },
        chat_instance: "chat-instance-1",
        data: "remind_later:pkg_42",
      },
    };

    await processInboundTelegramUpdate(makeRequest(cbUpdate), deps);

    expect(sendToAsh).toHaveBeenCalledTimes(1);
    expect(setTriggerAttribute).toHaveBeenCalledWith("telegram.callback");
  });

  it("volunteer-accept tap (channel-deterministic per #89/#96) → no attribute, no sendToAsh", async () => {
    // The accept_reception_group callback runs its own deterministic
    // flow (lib write + edit card + send 2 DMs) and NEVER calls
    // `sendToAsh`. Therefore it must also never call
    // `setTriggerAttribute` — there's no `ash.turn` row for it.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps({
      isRegisteredResident: true,
    });

    const cbUpdate = {
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: 300, is_bot: false, first_name: "Marlene", language_code: "de" },
        message: {
          message_id: 555,
          chat: { id: -100123, type: "supergroup" },
        },
        chat_instance: "chat-instance-1",
        data: "accept_reception_group:req_42",
      },
    };

    await processInboundTelegramUpdate(makeRequest(cbUpdate), deps);

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("registration DM (channel-deterministic per #97) → no attribute, no sendToAsh", async () => {
    // `/register` is intercepted by the channel; the agent never runs,
    // so no Trigger column entry should be created.
    const { deps, sendToAsh, setTriggerAttribute } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({
          chatId: 1,
          text: "/register Diego de Miguel, Lutterothstrasse 69 Erdgeschoss",
          fromUserId: 99,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(sendToAsh).not.toHaveBeenCalled();
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("orchestrator tolerates an absent setTriggerAttribute dep (optional)", async () => {
    // The spike webhook + tests that don't care about observability
    // wiring shouldn't need to provide the dep. Optional-chaining at
    // every call site keeps the channel running without it.
    const { deps, sendToAsh } = buildDeps();
    const depsWithoutTrigger: ProcessUpdateDeps = {
      ...deps,
      setTriggerAttribute: undefined,
    };

    const res = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 1, text: "hi", fromUserId: 99 })),
      depsWithoutTrigger,
    );

    expect(res.status).toBe(204);
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });
});

describe("processInboundTelegramUpdate — Flow 1 group text (v2.1 #106 Slice 1 — channel-deterministic register-package)", () => {
  function groupRegistrationUpdate(opts: {
    text: string;
    chatId?: number;
    fromUserId?: number;
    languageCode?: string;
  }): Record<string, unknown> {
    return {
      update_id: 300,
      message: {
        message_id: 1,
        date: 1,
        text: opts.text,
        chat: { id: opts.chatId ?? -100, type: "supergroup" },
        from: {
          id: opts.fromUserId ?? 100,
          is_bot: false,
          first_name: "Holder",
          language_code: opts.languageCode ?? "de",
        },
      },
    };
  }

  function holderResident(): Resident {
    return {
      id: "100",
      name: "Diego Demiguel",
      street: "Lutterothstrasse",
      houseNumber: "69",
      platformId: "100",
      platform: "telegram",
      language: "de",
      availabilityPatterns: [],
      registeredAt: Date.now(),
      source: "explicit",
      confirmed: true,
    };
  }

  it("on high-confidence classifier verdict + registered-resident recipient: calls registerPackage + posts announce-only group ack + DMs recipient with [Abgeholt] keyboard (v2.1 #114: no group keyboard), no agent invocation", async () => {
    const {
      deps,
      sendToAsh,
      classifyGroupMessage,
      registerPackage,
      sendDirectMessage,
    } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Marlene Hartmann", houseNumber: "88" }],
        carrier: "DHL",
        confidence: "high",
        reason: "explicit package registration",
      },
      // Default registerPackageResult resolves to a registered Resident
      // (the recipient summary in buildDeps's default).
    });

    const res = await processInboundTelegramUpdate(
      makeRequest(
        groupRegistrationUpdate({ text: "Paket für Marlene Hartmann (Hs.88)" }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(classifyGroupMessage).toHaveBeenCalledTimes(1);
    expect(registerPackage).toHaveBeenCalledTimes(1);
    // Two sendDirectMessage calls: one to the group (announce-only),
    // one to the recipient (carries the [Abgeholt] keyboard).
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    // Agent is NEVER invoked on this path.
    expect(sendToAsh).not.toHaveBeenCalled();

    // Group ack: posted to the inbound chat id (the group). v2.1
    // #114 regression pin: NO inline keyboard on the group ack.
    const [groupChatId, groupText, groupEntities, groupKeyboard] =
      sendDirectMessage.mock.calls[0]!;
    expect(groupChatId).toBe(-100);
    expect(groupText).toContain("📦 Paket von Diego de Miguel (69)");
    expect(groupText).toContain("an Marlene Hartmann (88)");
    expect(groupEntities).toBeUndefined();
    expect(groupKeyboard).toBeUndefined();

    // Recipient DM: sent to the recipient's chat id (numeric of the
    // platformId), carries the pickup keyboard (the only surface
    // that does post-#114).
    const [recipientChatId, recipientText, _recipientEntities, recipientKeyboard] =
      sendDirectMessage.mock.calls[1]!;
    expect(recipientChatId).toBe(200);
    expect(recipientText).toContain("Hi Marlene Hartmann!");
    expect(recipientText).toContain("Diego de Miguel hat ein Paket");
    expect(recipientText).toContain("[Abgeholt]");
    expect(recipientKeyboard).toBeDefined();
    expect(
      (recipientKeyboard as { inline_keyboard: ReadonlyArray<unknown> })
        .inline_keyboard,
    ).toHaveLength(1);
  });

  it("v2.1 #116 — on Flow 2 fulfillment linkage (receptionRequestFulfilled !== null): suppresses the group ack, DMs the holder a private confirmation, still DMs the recipient with the [Abgeholt] keyboard", async () => {
    const {
      deps,
      sendToAsh,
      registerPackage,
      sendDirectMessage,
    } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Patricia Höfer", houseNumber: "90" }],
        carrier: "DHL",
        confidence: "high",
        reason: "explicit package registration",
      },
      registerPackageResult: {
        package: {
          id: "pkg_linked_text",
          streetId: "Methfesselstraße",
          recipientResidentId: "200",
          recipientName: "Patricia Höfer",
          recipientHouseNumber: "90",
          holderResidentId: "100",
          carrier: "DHL",
          status: "held",
          receivedAt: Date.now(),
          pickedUpAt: null,
          reminded: false,
          receptionRequestId: "req_matched_text",
        } satisfies Package,
        holder: {
          id: "100",
          platformId: "100",
          name: "Diego de Miguel",
          houseNumber: "69",
          floor: null,
          buzzerName: null,
          language: "de",
        },
        recipientResolution: {
          kind: "resident",
          resident: {
            id: "200",
            name: "Patricia Höfer",
            houseNumber: "90",
            language: "de",
            floor: null,
            buzzerName: null,
          },
        },
        receptionRequestFulfilled: {
          requestId: "req_matched_text",
          requesterResidentId: "200",
          previousStatus: "matched",
        },
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        groupRegistrationUpdate({ text: "Paket für Patricia Höfer (Hs.90)" }),
      ),
      deps,
    );

    expect(registerPackage).toHaveBeenCalledTimes(1);
    // Two DMs only: holder confirmation + recipient DM. No group ack.
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(sendToAsh).not.toHaveBeenCalled();

    // Holder confirmation: sent to the holder's platformId, NOT to
    // the group chat id (-100).
    const [holderChatId, holderText, , holderKeyboard] =
      sendDirectMessage.mock.calls[0]!;
    expect(holderChatId).toBe(100);
    expect(holderText).toContain("Paket für Patricia Höfer erkannt");
    expect(holderText).toContain("Patricia Höfer wurde benachrichtigt");
    expect(holderKeyboard).toBeUndefined();

    // Regression pin: NO call addresses the group chat on this branch.
    for (const call of sendDirectMessage.mock.calls) {
      expect(call[0]).not.toBe(-100);
    }

    // Recipient DM unchanged from the non-suppression path.
    const [recipientChatId, recipientText, , recipientKeyboard] =
      sendDirectMessage.mock.calls[1]!;
    expect(recipientChatId).toBe(200);
    expect(recipientText).toContain("Hi Patricia Höfer!");
    expect(recipientText).toContain("[Abgeholt]");
    expect(recipientKeyboard).toBeDefined();
  });

  it("stays silent + does NOT invoke the agent when the classifier returns isPackageRegistration: false (off-topic group chat)", async () => {
    const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
      groupClassification: {
        isPackageRegistration: false,
        recipients: [],
        confidence: "low",
        reason: "not a registration",
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(groupRegistrationUpdate({ text: "Wer hat Lust auf Pizza?" })),
      deps,
    );

    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("on medium-conf + recipient resolves to a Resident: registers deterministically (treats medium as high when second signal converges, v2.1 #109)", async () => {
    const {
      deps,
      sendToAsh,
      resolveRecipient,
      registerPackage,
      sendDirectMessage,
    } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Foo", houseNumber: "88" }],
        confidence: "medium",
        reason: "phrasing slightly ambiguous",
      },
      resolveRecipientResult: {
        kind: "resident",
        resident: {
          id: "200",
          name: "Foo",
          houseNumber: "88",
          language: "de",
          floor: null,
          buzzerName: null,
        },
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(groupRegistrationUpdate({ text: "Vielleicht Paket für Foo?" })),
      deps,
    );

    expect(resolveRecipient).toHaveBeenCalledTimes(1);
    expect(registerPackage).toHaveBeenCalledTimes(1);
    // Group ack + recipient DM, no agent invocation.
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("on medium-conf + recipient does NOT resolve to a Resident: falls through with [FLOW_1 CLARIFICATION reason=low-conf], no Package write (v2.1 #109)", async () => {
    const {
      deps,
      sendToAsh,
      resolveRecipient,
      registerPackage,
      sendDirectMessage,
    } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Foo", houseNumber: "88" }],
        confidence: "medium",
        reason: "phrasing ambiguous",
      },
      resolveRecipientResult: { kind: "unknown" },
    });

    await processInboundTelegramUpdate(
      makeRequest(groupRegistrationUpdate({ text: "Vielleicht Paket für Foo?" })),
      deps,
    );

    expect(resolveRecipient).toHaveBeenCalledTimes(1);
    // No Package write at medium-conf + non-resident.
    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    // Clarification synthetic to the agent.
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    const [synthetic] = sendToAsh.mock.calls[0]!;
    expect(synthetic).toContain("[FLOW_1 CLARIFICATION");
    expect(synthetic).toContain("reason=low-conf");
  });

  it("on medium-conf + 2+ recipients: falls through with reason=ambiguous-multi, no Package writes (v2.1 #109)", async () => {
    const {
      deps,
      sendToAsh,
      resolveRecipient,
      registerPackage,
      sendDirectMessage,
    } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [
          { name: "Foo", houseNumber: "88" },
          { name: "Bar", houseNumber: "90" },
        ],
        confidence: "medium",
        reason: "two recipients, partial confidence",
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        groupRegistrationUpdate({
          text: "Pakete für Foo und Bar?",
        }),
      ),
      deps,
    );

    // No per-recipient resolve, no register.
    expect(resolveRecipient).not.toHaveBeenCalled();
    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    const [synthetic] = sendToAsh.mock.calls[0]!;
    expect(synthetic).toContain("reason=ambiguous-multi");
  });

  it("on isPackageRegistration:true + 0 recipients: falls through with reason=missing-recipient (v2.1 #109)", async () => {
    const { deps, sendToAsh, registerPackage } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [],
        confidence: "high",
        reason: "looks like a registration but no recipient parsed",
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(groupRegistrationUpdate({ text: "Paket angekommen" })),
      deps,
    );

    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    const [synthetic] = sendToAsh.mock.calls[0]!;
    expect(synthetic).toContain("reason=missing-recipient");
  });

  it("on low-conf + isPackageRegistration:true: falls through with reason=low-conf (v2.1 #109)", async () => {
    const { deps, sendToAsh, registerPackage } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Foo", houseNumber: "88" }],
        confidence: "low",
        reason: "weak package signal",
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        groupRegistrationUpdate({ text: "vielleicht Paket für Foo, weiß nicht" }),
      ),
      deps,
    );

    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
    const [synthetic] = sendToAsh.mock.calls[0]!;
    expect(synthetic).toContain("reason=low-conf");
  });

  it("stays silent on classifier outage (both primary + fallback errored)", async () => {
    const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
      groupClassificationError: new Error("model outage"),
    });

    await processInboundTelegramUpdate(
      makeRequest(groupRegistrationUpdate({ text: "Paket für jemanden" })),
      deps,
    );

    expect(registerPackage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("DMs the unregistered holder a /register nudge when registerPackage throws REGISTER_PACKAGE_HOLDER_NOT_REGISTERED — silent in the group", async () => {
    const error = Object.assign(new Error("not registered"), {
      code: "REGISTER_PACKAGE_HOLDER_NOT_REGISTERED",
    });
    const {
      deps,
      sendToAsh,
      registerPackage,
      sendDirectMessage,
    } = buildDeps({
      registeredResident: null, // holder not registered
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Marlene", houseNumber: "88" }],
        confidence: "high",
        reason: "looks like a registration",
      },
      registerPackageError: error,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        groupRegistrationUpdate({
          text: "Paket für Marlene (Hs.88)",
          fromUserId: 999,
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(registerPackage).toHaveBeenCalledTimes(1);
    // One DM goes out — the localised /register nudge to the holder.
    // Group stays silent (no group ack on this branch).
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [nudgeChatId, nudgeText] = sendDirectMessage.mock.calls[0]!;
    expect(nudgeChatId).toBe(999);
    expect(nudgeText).toContain("/register");
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("on high-conf + recipient resolution 'unknown': posts the deterministic group question (📦 Paket für X – kennt jemand X?), no agent invocation (v2.1 #109)", async () => {
    const { deps, sendToAsh, registerPackage, sendDirectMessage } = buildDeps({
      registeredResident: holderResident(),
      groupClassification: {
        isPackageRegistration: true,
        recipients: [{ name: "Stranger", houseNumber: "999" }],
        confidence: "high",
        reason: "high-conf registration",
      },
      registerPackageResult: {
        package: {
          id: "pkg_unknown",
          streetId: "Lutterothstrasse",
          recipientResidentId: null,
          recipientName: "Stranger",
          recipientHouseNumber: "999",
          holderResidentId: "100",
          carrier: "unknown",
          status: "held",
          receivedAt: Date.now(),
          pickedUpAt: null,
          reminded: false,
        } satisfies Package,
        holder: {
          id: "100",
          platformId: "100",
          name: "Diego Demiguel",
          houseNumber: "69",
          floor: null,
          buzzerName: null,
          language: "de",
        },
        recipientResolution: { kind: "unknown" },
        receptionRequestFulfilled: null,
      },
    });

    await processInboundTelegramUpdate(
      makeRequest(
        groupRegistrationUpdate({ text: "Paket für Stranger (Hs.999)" }),
      ),
      deps,
    );

    // Package row is still written (cron sweep handles staleness).
    expect(registerPackage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendDirectMessage.mock.calls[0]!;
    expect(chatId).toBe(-100);
    expect(text).toBe("📦 Paket für Stranger – kennt jemand Stranger?");
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("anonymous group post (no fromUserId) stays silent — classifier is not even called", async () => {
    const { deps, sendToAsh, classifyGroupMessage, sendDirectMessage } =
      buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({
        update_id: 400,
        message: {
          message_id: 1,
          date: 1,
          text: "Paket für jemanden",
          chat: { id: -100, type: "supergroup" },
          // No `from` — anonymous group post.
        },
      }),
      deps,
    );

    expect(classifyGroupMessage).not.toHaveBeenCalled();
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });
});
