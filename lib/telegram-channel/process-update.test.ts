import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "experimental-ash/channels";

import type { AcceptReceptionRequestResult } from "../reception-request.js";

import {
  processInboundTelegramUpdate,
  type Flow2ClassificationResult,
  type ProcessUpdateDeps,
  type TelegramChannelState,
  type TelegramSessionAuth,
} from "./process-update.js";
import type { ReceptionRequest, Resident } from "../redis.js";

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
  parseLabel: ReturnType<typeof vi.fn>;
  parseTrackingPage: ReturnType<typeof vi.fn>;
  answerCallback: ReturnType<typeof vi.fn>;
  stripKeyboard: ReturnType<typeof vi.fn>;
  getPackageRecipientId: ReturnType<typeof vi.fn>;
  recordTelegramObservation: ReturnType<typeof vi.fn>;
  isRegisteredResident: ReturnType<typeof vi.fn>;
  classifyDmIntent: ReturnType<typeof vi.fn>;
  getRegisteredResident: ReturnType<typeof vi.fn>;
  createReceptionRequest: ReturnType<typeof vi.fn>;
  acceptReceptionRequest: ReturnType<typeof vi.fn>;
  editGroupCard: ReturnType<typeof vi.fn>;
  sendDirectMessage: ReturnType<typeof vi.fn>;
  registerResident: ReturnType<typeof vi.fn>;
}

type ParsedLabel = NonNullable<
  Awaited<ReturnType<ProcessUpdateDeps["parseLabel"]>>
>;
type ParsedTrackingPage = NonNullable<
  Awaited<ReturnType<ProcessUpdateDeps["parseTrackingPage"]>>
>;

function buildDeps(overrides: {
  session?: Session;
  expectedSecret?: string | undefined;
  fileUrl?: string;
  parsedLabel?: ParsedLabel | null;
  parsedTrackingPage?: ParsedTrackingPage | null;
  packageRecipientId?: string | null;
  isRegisteredResident?: boolean;
  classification?: Flow2ClassificationResult;
  registeredResident?: Resident | null;
  acceptResult?: AcceptReceptionRequestResult;
  registerResult?: { resident: Resident; updated: boolean };
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
  const defaultParsedLabel: ParsedLabel = {
    carrier: "DHL",
    recipientName: "Anna-Sophie Meyer",
    recipientHouseNumber: "92",
    trackingNumber: "00340434161094021899",
    confidence: "high",
    reason: "all fields legible",
  };
  const parseLabel = vi
    .fn()
    .mockResolvedValue(
      "parsedLabel" in overrides ? overrides.parsedLabel : defaultParsedLabel,
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
  const answerCallback = vi.fn().mockResolvedValue(undefined);
  const stripKeyboard = vi.fn().mockResolvedValue(undefined);
  const getPackageRecipientId = vi
    .fn()
    .mockResolvedValue(
      "packageRecipientId" in overrides ? overrides.packageRecipientId : null,
    );
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
  const defaultClassification: Flow2ClassificationResult = {
    isFlow2: false,
    absenceSignal: false,
    confidence: "low",
    reason: "default test stub: not Flow 2",
  };
  const classifyDmIntent = vi
    .fn()
    .mockResolvedValue(overrides.classification ?? defaultClassification);
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
  return {
    sendToAsh,
    waitUntil,
    drainSession,
    getFileUrl,
    parseLabel,
    parseTrackingPage,
    answerCallback,
    stripKeyboard,
    getPackageRecipientId,
    recordTelegramObservation,
    isRegisteredResident,
    classifyDmIntent,
    getRegisteredResident,
    createReceptionRequest,
    acceptReceptionRequest,
    editGroupCard,
    sendDirectMessage,
    registerResident,
    deps: {
      expectedSecret:
        "expectedSecret" in overrides ? overrides.expectedSecret : SECRET,
      sendToAsh: sendToAsh as ProcessUpdateDeps["sendToAsh"],
      waitUntil,
      drainSession,
      getFileUrl,
      parseLabel,
      parseTrackingPage,
      answerCallback,
      stripKeyboard,
      getPackageRecipientId,
      recordTelegramObservation,
      isRegisteredResident,
      classifyDmIntent,
      getRegisteredResident,
      createReceptionRequest,
      acceptReceptionRequest,
      editGroupCard,
      sendDirectMessage,
      registerResident,
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

  it("parses a GROUP label photo via parseLabel and forwards a synthetic text message naming the extracted fields", async () => {
    // Group photos route through parseLabel (Flow 1). DM photos route
    // through parseTrackingPage (Flow 2 v2 / #69) — see the dedicated
    // describe block further down for those cases.
    const fileUrl =
      "https://api.telegram.org/file/bot111:AAA/photos/file_99.jpg";
    const { deps, sendToAsh, getFileUrl, parseLabel, parseTrackingPage } =
      buildDeps({
        fileUrl,
        parsedLabel: {
          carrier: "DHL",
          recipientName: "Natascha Elter",
          recipientHouseNumber: "88",
          confidence: "high",
          reason: "label legible",
        },
      });

    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        caption: "Paket für Natascha",
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T", language_code: "de" },
        photo: [
          { file_id: "small", file_size: 100, width: 90, height: 90 },
          { file_id: "large", file_size: 5000, width: 1280, height: 1280 },
        ],
      },
    };

    const res = await processInboundTelegramUpdate(makeRequest(update), deps);
    expect(res.status).toBe(204);

    expect(getFileUrl).toHaveBeenCalledWith("large");

    // parseLabel receives the URL + caption — no bytes, no mediaType. The
    // Gateway server fetches the URL itself; passing inline bytes would
    // make the Gateway client emit a `data:` URI the server rejects.
    expect(parseLabel).toHaveBeenCalledTimes(1);
    const parseArgs = parseLabel.mock.calls[0]![0];
    expect(parseArgs.imageUrl).toBe(fileUrl);
    expect(parseArgs.caption).toBe("Paket für Natascha");
    expect(parseArgs.imageBase64).toBeUndefined();
    expect(parseArgs.mediaType).toBeUndefined();

    // parseTrackingPage must NOT be called on the group path.
    expect(parseTrackingPage).not.toHaveBeenCalled();

    const [message, options] = sendToAsh.mock.calls[0]!;
    expect(typeof message).toBe("string");
    expect(message).toContain("[label parsed]");
    expect(message).toContain("carrier=DHL");
    expect(message).toContain("recipient=Natascha Elter");
    expect(message).toContain("house=88");
    expect(message).toContain("confidence=high");
    expect(message).toContain("caption='Paket für Natascha'");
    // High confidence → no "please confirm" suffix.
    expect(message).not.toMatch(/please confirm/);

    expect(options.state).toEqual<TelegramChannelState>({
      chatId: 42,
      isGroup: true,
      fromUserId: 99,
      fromLanguageCode: "de",
    });
  });

  it("substitutes a placeholder caption when a group label photo arrives without text", async () => {
    const { deps, sendToAsh, getFileUrl, parseLabel } = buildDeps();

    const update = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "only", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    expect(getFileUrl).toHaveBeenCalledWith("only");
    // No caption passed to parseLabel when the user didn't send one.
    const parseArgs = parseLabel.mock.calls[0]![0];
    expect(parseArgs.caption).toBeUndefined();

    const [message] = sendToAsh.mock.calls[0]!;
    expect(typeof message).toBe("string");
    expect(message).toContain("caption='(no caption)'");
  });

  it("appends a please-confirm suffix when the label vision tool returns low confidence", async () => {
    const { deps, sendToAsh } = buildDeps({
      parsedLabel: {
        carrier: "unknown",
        recipientName: "M?yer",
        confidence: "low",
        reason: "recipient name partially obscured",
      },
    });

    const update = {
      update_id: 3,
      message: {
        message_id: 3,
        date: 1,
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "only", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("confidence=low");
    expect(message).toMatch(/please confirm/i);
  });

  it("falls back to a generic 'photo received, label could not be parsed' message when parseLabel returns null (group photo)", async () => {
    const { deps, sendToAsh, parseLabel } = buildDeps({ parsedLabel: null });

    const update = {
      update_id: 4,
      message: {
        message_id: 4,
        date: 1,
        caption: "kann das jemand lesen?",
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    expect(parseLabel).toHaveBeenCalledTimes(1);
    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[photo received, label could not be parsed]");
    expect(message).toContain("caption: kann das jemand lesen?");
    expect(message).toMatch(/retype|type the recipient/i);
  });

  it("falls back to the label parse-failure message when parseLabel throws (group photo)", async () => {
    const { deps, sendToAsh, parseLabel } = buildDeps();
    parseLabel.mockRejectedValueOnce(new Error("vision provider down"));

    const update = {
      update_id: 5,
      message: {
        message_id: 5,
        date: 1,
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[photo received, label could not be parsed]");
  });

  it("falls back to the label parse-failure message when getFileUrl throws (group photo)", async () => {
    const { deps, sendToAsh, parseLabel, getFileUrl } = buildDeps();
    getFileUrl.mockRejectedValueOnce(new Error("Bot API 404"));

    const update = {
      update_id: 6,
      message: {
        message_id: 6,
        date: 1,
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    expect(parseLabel).not.toHaveBeenCalled();
    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[photo received, label could not be parsed]");
  });

  it("omits absent label fields from the synthetic message (group photo)", async () => {
    const { deps, sendToAsh } = buildDeps({
      parsedLabel: {
        carrier: "DHL",
        // No recipientName, no recipientHouseNumber, no trackingNumber.
        confidence: "medium",
        reason: "only carrier visible",
      },
    });

    const update = {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: 42, type: "supergroup" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("carrier=DHL");
    expect(message).not.toContain("recipient=");
    expect(message).not.toContain("house=");
    expect(message).not.toContain("tracking=");
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

    it("on high-confidence + absenceSignal:true + registered caller, writes a ReceptionRequest and hands [FLOW_2 DONE]", async () => {
      const fileUrl =
        "https://api.telegram.org/file/bot111:AAA/photos/file_77.jpg";
      const resident = dmRegisteredResident("de");
      const {
        deps,
        sendToAsh,
        getFileUrl,
        parseLabel,
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
      expect(parseLabel).not.toHaveBeenCalled();

      // Channel writes the ReceptionRequest BEFORE the agent runs.
      expect(getRegisteredResident).toHaveBeenCalledWith(99);
      expect(createReceptionRequest).toHaveBeenCalledTimes(1);
      const [caller, input] = createReceptionRequest.mock.calls[0]!;
      expect(caller).toBe(resident);
      expect(input.carrier).toBe("DHL");
      // ISO endpoints are converted to Unix ms before the lib call.
      expect(input.expectedWindowStartAt).toBe(
        Date.parse("2026-05-19T13:00:00Z"),
      );
      expect(input.expectedWindowEndAt).toBe(
        Date.parse("2026-05-19T16:00:00Z"),
      );

      const [message, options] = sendToAsh.mock.calls[0]!;
      expect(typeof message).toBe("string");
      expect(message).toContain("[FLOW_2 DONE language=de]");
      // The synthetic must close down further tool calls — same shape
      // Slice 1 ships from the classifier path.
      expect(message).toMatch(/do not call/i);
      expect(message).toContain("post_to_group");
      // Slice 5 (#90) hard-deleted create_reception_request, so the
      // synthetic must NOT name it (the model has no such tool now).
      expect(message).not.toContain("create_reception_request");
      // No remnants of the v2 [tracking page parsed] synthetic.
      expect(message).not.toContain("[tracking page parsed]");

      expect(options.state).toEqual<TelegramChannelState>({
        chatId: 42,
        isGroup: false,
        fromUserId: 99,
        fromLanguageCode: "de",
      });
    });

    it("treats absenceSignal:undefined as implicit absence (uploading a tracking page in DM is itself the absence signal)", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, createReceptionRequest } = buildDeps({
        parsedTrackingPage: {
          carrier: "Hermes",
          // No absenceSignal — the vision tool found no caption signal
          // either way. Channel must treat this as Flow 2.
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

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[FLOW_2 DONE language=de]");
    });

    it("on absenceSignal:false (explicit non-absence — search intent), hands [VISION_LOW_CONFIDENCE] and does NOT post the card", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, createReceptionRequest } = buildDeps({
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

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
      // The synthetic must embed the parsed fields so the agent can
      // reason about the user's intent.
      expect(message).toContain("carrier=DHL");
      expect(message).toContain("absenceSignal=false");
      // And it must direct the agent at /receive — Slice 2's recovery path.
      expect(message).toMatch(/\/receive/);
    });

    it("on confidence:low, hands [VISION_LOW_CONFIDENCE] with partial fields and does NOT post the card", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, createReceptionRequest } = buildDeps({
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
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
      expect(message).toContain("carrier=unknown");
      expect(message).toContain("confidence=low");
      expect(message).toMatch(/\/receive/);
    });

    it("on confidence:medium (not high), hands [VISION_LOW_CONFIDENCE] and does NOT post the card", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, createReceptionRequest } = buildDeps({
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
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
      expect(message).toContain("carrier=DHL");
      expect(message).toContain("confidence=medium");
    });

    it("on parseTrackingPage returning null, hands [VISION_LOW_CONFIDENCE] with no partial fields", async () => {
      const { deps, sendToAsh, parseLabel, parseTrackingPage, createReceptionRequest } =
        buildDeps({ parsedTrackingPage: null });

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
      expect(parseLabel).not.toHaveBeenCalled();
      expect(createReceptionRequest).not.toHaveBeenCalled();
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
      expect(message).toContain("caption: kannst du das lesen?");
      expect(message).toContain("No fields were extracted");
      expect(message).toMatch(/\/receive/);
    });

    it("on parseTrackingPage throwing, hands [VISION_LOW_CONFIDENCE]", async () => {
      const { deps, sendToAsh, parseTrackingPage, createReceptionRequest } =
        buildDeps();
      parseTrackingPage.mockRejectedValueOnce(
        new Error("vision provider down"),
      );

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(createReceptionRequest).not.toHaveBeenCalled();
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
    });

    it("on getFileUrl throwing (DM photo), hands [VISION_LOW_CONFIDENCE] without invoking any vision tool", async () => {
      const { deps, sendToAsh, parseLabel, parseTrackingPage, getFileUrl, createReceptionRequest } =
        buildDeps();
      getFileUrl.mockRejectedValueOnce(new Error("Bot API 404"));

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(parseTrackingPage).not.toHaveBeenCalled();
      expect(parseLabel).not.toHaveBeenCalled();
      expect(createReceptionRequest).not.toHaveBeenCalled();
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
    });

    it("on high-confidence but unregistered caller, hands [VISION_LOW_CONFIDENCE] (no Resident to attach the request to)", async () => {
      const { deps, sendToAsh, createReceptionRequest } = buildDeps({
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
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
    });

    it("on high-confidence + createReceptionRequest throwing (Redis hiccup), hands [VISION_LOW_CONFIDENCE]", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, sendToAsh, createReceptionRequest } = buildDeps({
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

      // The throw means no card was posted. The agent now gets the
      // low-confidence prompt to ask the user to retry via /receive —
      // the same shape as the classifier path on Redis failure.
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
    });

    it("on anonymous DM photo (no fromUserId), hands [VISION_LOW_CONFIDENCE] without consulting the directory", async () => {
      const { deps, sendToAsh, createReceptionRequest, getRegisteredResident } =
        buildDeps({
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
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE");
    });

    it("uses the resident's stored language for the FLOW_2 DONE synthetic when present", async () => {
      const resident = dmRegisteredResident("tr");
      const { deps, sendToAsh } = buildDeps({
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

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[FLOW_2 DONE language=tr]");
    });

    it("falls back to the Telegram client language code when the resident has no stored language", async () => {
      const resident: Resident = {
        ...dmRegisteredResident("de"),
        language: undefined,
      };
      const { deps, sendToAsh } = buildDeps({
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

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[FLOW_2 DONE language=en]");
    });

    it("falls back to 'de' when neither the resident nor Telegram supply a language code on the low-confidence path", async () => {
      const { deps, sendToAsh } = buildDeps({
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

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[VISION_LOW_CONFIDENCE language=de]");
    });

    it("substitutes (no caption) when the DM photo arrives without text on the low-confidence path", async () => {
      const { deps, sendToAsh } = buildDeps({
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

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("caption: (no caption)");
    });

    it("does NOT invoke parseLabel on the DM path even when registered residents would otherwise short-circuit", async () => {
      const resident = dmRegisteredResident("de");
      const { deps, parseLabel } = buildDeps({
        parsedTrackingPage: {
          carrier: "DHL",
          absenceSignal: true,
          confidence: "high",
          reason: "clean tracking page",
        },
        registeredResident: resident,
      });

      await processInboundTelegramUpdate(
        makeRequest(dmPhotoUpdate({ fromUserId: 99, languageCode: "de" })),
        deps,
      );

      expect(parseLabel).not.toHaveBeenCalled();
    });
  });

  it("does not call getFileUrl or parseLabel on text-only updates", async () => {
    const { deps, getFileUrl, parseLabel } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 5, text: "hi", fromUserId: 99 })),
      deps,
    );

    expect(getFileUrl).not.toHaveBeenCalled();
    expect(parseLabel).not.toHaveBeenCalled();
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

  it("acks, strips the keyboard, and synthesizes a confirm_pickup message into the session (DM)", async () => {
    const session = makeSession("sess_cb");
    const { deps, sendToAsh, answerCallback, stripKeyboard, waitUntil, drainSession } =
      buildDeps({ session });

    const res = await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: 42,
          messageId: 555,
          fromUserId: 99,
          data: "confirm_pickup:pkg_42",
          languageCode: "de",
        }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(answerCallback).toHaveBeenCalledWith("cb_abc");
    expect(stripKeyboard).toHaveBeenCalledWith(42, 555);

    expect(sendToAsh).toHaveBeenCalledTimes(1);
    const [text, options] = sendToAsh.mock.calls[0]!;
    expect(text).toMatch(/confirm.*pickup.*pkg_42/i);
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
    await waitUntil.mock.calls[0]![0];
    expect(drainSession).toHaveBeenCalledWith(session, 42);
  });

  it("uses tg:<chatId> as the continuation token on callback taps (no per-run id reuse — #65)", async () => {
    // Regression test for #65 on the callback path. Same root cause as
    // the message-path regression: the orchestrator used to reuse the
    // returned per-run wrun_… session id as the next turn's continuation
    // token, which Ash silently rejected and respun from scratch. Stable
    // tg:<chatId> keying eliminates the failure mode.
    const session = makeSession("wrun_01KRZEH9RHK4EPTWZ6BDGGTSVQ");
    const { deps, sendToAsh } = buildDeps({ session });

    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({ chatId: 42, messageId: 1, fromUserId: 99, data: "confirm_pickup:pkg_1" }),
      ),
      deps,
    );

    const options = sendToAsh.mock.calls[0]![1];
    expect(options.continuationToken).toBe("tg:42");
    expect(options.continuationToken).not.toMatch(/^wrun_/);
  });

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

  it("gates group confirm_pickup on recipient scope — wrong tapper gets a toast and no agent invocation", async () => {
    const { deps, sendToAsh, answerCallback, stripKeyboard, getPackageRecipientId } =
      buildDeps({ packageRecipientId: "200" });

    const res = await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: -100123,
          messageId: 1,
          fromUserId: 99, // not 200
          data: "confirm_pickup:pkg_42",
          chatType: "supergroup",
        }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(getPackageRecipientId).toHaveBeenCalledWith("pkg_42");
    expect(answerCallback).toHaveBeenCalledWith(
      "cb_abc",
      expect.stringMatching(/only the recipient/i),
    );
    expect(stripKeyboard).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("admits group confirm_pickup when the tapper IS the recipient", async () => {
    const { deps, sendToAsh, stripKeyboard } = buildDeps({
      packageRecipientId: "99",
    });

    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: -100123,
          messageId: 1,
          fromUserId: 99,
          data: "confirm_pickup:pkg_42",
          chatType: "supergroup",
        }),
      ),
      deps,
    );

    expect(stripKeyboard).toHaveBeenCalledWith(-100123, 1);
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("rejects group confirm_pickup when the package is unknown (recipient lookup returns null)", async () => {
    const { deps, sendToAsh, stripKeyboard } = buildDeps({
      packageRecipientId: null,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: -100123,
          messageId: 1,
          fromUserId: 99,
          data: "confirm_pickup:pkg_missing",
          chatType: "supergroup",
        }),
      ),
      deps,
    );

    expect(stripKeyboard).not.toHaveBeenCalled();
    expect(sendToAsh).not.toHaveBeenCalled();
  });

  it("does NOT apply the recipient-scope check in a DM (1:1 already scoped to the tapper)", async () => {
    const { deps, sendToAsh, getPackageRecipientId } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({
          chatId: 42,
          messageId: 1,
          fromUserId: 99,
          data: "confirm_pickup:pkg_42",
        }),
      ),
      deps,
    );

    expect(getPackageRecipientId).not.toHaveBeenCalled();
    expect(sendToAsh).toHaveBeenCalledTimes(1);
  });

  it("records a KnownTelegramUser observation on every callback tap, including rejected ones (#45)", async () => {
    // Wrong tapper on a group confirm_pickup — the scope guard rejects and
    // sendToAsh is NOT called, but the bot has still seen this user and
    // must capture them so they can be mentioned later.
    const { deps, sendToAsh, recordTelegramObservation } = buildDeps({
      packageRecipientId: "different-user",
    });

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

  it("continues to drive the agent even if answerCallback or stripKeyboard throw", async () => {
    const { deps, sendToAsh, answerCallback, stripKeyboard } = buildDeps();
    answerCallback.mockRejectedValueOnce(new Error("ack failed"));
    stripKeyboard.mockRejectedValueOnce(new Error("edit failed"));

    const res = await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({ chatId: 42, messageId: 1, fromUserId: 99, data: "confirm_pickup:pkg_42" }),
      ),
      deps,
    );

    expect(res.status).toBe(204);
    expect(sendToAsh).toHaveBeenCalledTimes(1);
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

      await processInboundTelegramUpdate(
        makeRequest(
          cbUpdate({
            chatId: 42,
            messageId: 1,
            fromUserId: 99,
            data: "confirm_pickup:pkg_42",
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

  it("hands the raw text to the agent on classifier verdict isFlow2=false", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        isFlow2: false,
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

  it("hands the raw text to the agent on isFlow2=true but confidence < high", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        isFlow2: true,
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

  it("on high-confidence Flow 2, calls createReceptionRequest and hands the agent a [FLOW_2 DONE] synthetic", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        isFlow2: true,
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

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[FLOW_2 DONE language=de]");
    // The synthetic must explicitly tell the agent NOT to fire any tools.
    expect(message).toMatch(/do not call/i);
    // It still names post_to_group + register_expected_delivery (those
    // tools still exist on the agent surface and the v2 regression at
    // #85 had the agent firing them mid-flow). create_reception_request
    // is gone after Slice 5 (#90) — the agent has no such tool, so the
    // synthetic must NOT mention it.
    expect(message).toContain("post_to_group");
    expect(message).not.toContain("create_reception_request");
  });

  it("uses the resident's stored language for the FLOW_2 DONE synthetic when present", async () => {
    const resident = dmRegisteredResident("es");
    const { deps, sendToAsh } = buildDeps({
      classification: {
        isFlow2: true,
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

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[FLOW_2 DONE language=es]");
  });

  it("falls back to the Telegram client language code when the resident has no stored language", async () => {
    const resident: Resident = {
      ...dmRegisteredResident("de"),
      language: undefined,
    };
    const { deps, sendToAsh } = buildDeps({
      classification: {
        isFlow2: true,
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

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[FLOW_2 DONE language=en]");
  });

  it("falls through to raw text when the caller is unregistered (createReceptionRequest needs a Resident)", async () => {
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      classification: {
        isFlow2: true,
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
        isFlow2: true,
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

  it("bare /receive writes a request with no carrier or window and hands [FLOW_2 DONE]", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      registeredResident: resident,
    });

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

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[FLOW_2 DONE language=de]");
  });

  it("`/receive DHL morgen 14-16` parses args and forwards them to createReceptionRequest", async () => {
    const resident = dmRegisteredResident("de");
    const { deps, sendToAsh, createReceptionRequest } = buildDeps({
      registeredResident: resident,
    });

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

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[FLOW_2 DONE language=de]");
  });

  it("uses the resident's stored language for the FLOW_2 DONE synthetic", async () => {
    const resident = dmRegisteredResident("tr");
    const { deps, sendToAsh } = buildDeps({ registeredResident: resident });

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

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[FLOW_2 DONE language=tr]");
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
    // Raw text passes through to the agent in groups.
    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toBe("/receive DHL morgen");
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

describe("FLOW_2 DONE synthetic shape (v2.1 Bug 2 regression, #94)", () => {
  // Trace A failure (#92 / #94): with the previous synthetic ("Reply
  // … with ONE short sentence confirming the group was asked. Do
  // NOT call post_to_group …") the model interpreted the
  // informative clauses as guidance it could ignore and emitted the
  // card text verbatim ("📦 DHL-Paket erwartet heute 06:00–08:00.
  // Kann jemand annehmen?") as the DM ack. The synthetic now has
  // to be DIRECTIVE: it must (a) name every shape the ack must NOT
  // take and (b) embed a known-good example sentence so the model
  // mirrors it instead of inventing one. These cases pin those
  // load-bearing constraints so future prompt tweaks can't silently
  // delete them.

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

  async function runFlow2Done(language: string): Promise<string> {
    const resident = dmRegisteredResident(language);
    const { deps, sendToAsh } = buildDeps({
      classification: {
        isFlow2: true,
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
          languageCode: language,
        }),
      ),
      deps,
    );

    const [message] = sendToAsh.mock.calls[0]!;
    if (typeof message !== "string") {
      throw new Error("expected synthetic to be a string");
    }
    return message;
  }

  it("prohibits the card-shaped ack patterns the model regurgitated live (#94 trace)", async () => {
    const message = await runFlow2Done("de");

    // Carrier name — observed in the buggy ack ("DHL-Paket erwartet …").
    expect(message).toMatch(/do not mention the carrier/i);
    // Window/date — observed as "heute 06:00–08:00" in the bug report.
    // The prohibition lives in the same `Do NOT mention …` clause that
    // forbids the carrier; assert the date + time window words land
    // inside that prohibition (rather than appearing accidentally in
    // an example sentence).
    expect(message).toMatch(/do not mention .*(date|window|time)/i);
    // Package emoji — observed prefix on the buggy ack body.
    expect(message).toContain("📦");
    expect(message).toMatch(/do not include.+(emoji|📦)/i);
    // The literal card question — observed as "Kann jemand
    // annehmen?" in the buggy ack.
    expect(message).toMatch(/do not (repeat|paraphrase).+card/i);
    expect(message).toMatch(/do not ask whether anyone can help/i);
  });

  it("embeds a known-good German example for de-language requesters", async () => {
    const message = await runFlow2Done("de");
    expect(message).toContain('Example (de):');
    expect(message).toContain(
      "Habe in der Gruppe gefragt — ich melde mich, sobald jemand zusagt.",
    );
    // The example MUST NOT contain the card-shaped tokens — if it did
    // the model would mirror the wrong shape.
    const exampleSegment = message.slice(message.indexOf('Example (de):'));
    expect(exampleSegment).not.toContain("📦");
    expect(exampleSegment).not.toContain("DHL");
    expect(exampleSegment).not.toContain("Kann jemand annehmen?");
  });

  it("embeds a known-good English example for en-language requesters", async () => {
    const message = await runFlow2Done("en");
    expect(message).toContain('Example (en):');
    expect(message).toContain(
      "Asked in the group — I'll let you know as soon as someone says yes.",
    );
  });

  it("embeds a known-good Spanish example for es-language requesters", async () => {
    const message = await runFlow2Done("es");
    expect(message).toContain('Example (es):');
    expect(message).toContain(
      "Pregunté en el grupo — te aviso en cuanto alguien responda.",
    );
  });

  it("embeds a known-good Turkish example for tr-language requesters", async () => {
    const message = await runFlow2Done("tr");
    expect(message).toContain('Example (tr):');
    expect(message).toContain(
      "Gruba sordum — biri yanıt verince haber veririm.",
    );
  });

  it("omits the example line for unknown languages (falls back to instructions.md rules)", async () => {
    const message = await runFlow2Done("ja");
    // Still names the language…
    expect(message).toContain("language=ja");
    expect(message).toContain("in ja");
    // …but the example block is omitted rather than emitting a German
    // example that the model would mistakenly mirror in Japanese.
    expect(message).not.toContain("Example (");
  });
});

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
    // Classifier runs (and returns isFlow2:false by default in this
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

  it("group `/register` does NOT fire the channel-deterministic path (only DMs trigger registration)", async () => {
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

    // Registration lib NOT called from a group message — registration
    // is a 1:1 onboarding flow.
    expect(registerResident).not.toHaveBeenCalled();
    // Group inbound still reaches the agent (same as legacy).
    expect(sendToAsh).toHaveBeenCalledTimes(1);
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
