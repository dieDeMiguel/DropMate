import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "experimental-ash/channels";

import {
  processInboundTelegramUpdate,
  type Flow2ClassificationResult,
  type ProcessUpdateDeps,
  type TelegramChannelState,
  type TelegramSessionAuth,
} from "./process-update.js";
import type { Resident } from "../redis.js";

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
      candidateResidentIds: [],
      volunteerResidentId: null,
      volunteerAvailability: null,
      status: "open",
      createdAt: Date.now(),
      respondedAt: null,
    },
    groupCard: { chatId: -100123, messageId: 42 },
  });
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

  describe("DM photo → parseTrackingPage (Flow 2 v2 / #69)", () => {
    it("parses a DM tracking-page photo via parseTrackingPage and forwards a synthetic text message naming the extracted fields", async () => {
      const fileUrl =
        "https://api.telegram.org/file/bot111:AAA/photos/file_77.jpg";
      const { deps, sendToAsh, getFileUrl, parseLabel, parseTrackingPage } =
        buildDeps({
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
        });

      const update = {
        update_id: 100,
        message: {
          message_id: 1,
          date: 1,
          caption: "kann jemand annehmen? bin nicht da",
          chat: { id: 42, type: "private" },
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

      // parseTrackingPage receives the URL + caption verbatim.
      expect(parseTrackingPage).toHaveBeenCalledTimes(1);
      const parseArgs = parseTrackingPage.mock.calls[0]![0];
      expect(parseArgs.imageUrl).toBe(fileUrl);
      expect(parseArgs.caption).toBe("kann jemand annehmen? bin nicht da");

      // parseLabel must NOT fire on the DM path.
      expect(parseLabel).not.toHaveBeenCalled();

      const [message, options] = sendToAsh.mock.calls[0]!;
      expect(typeof message).toBe("string");
      expect(message).toContain("[tracking page parsed]");
      expect(message).toContain("carrier=DHL");
      expect(message).toContain("trackingNumber=00340434161094021899");
      expect(message).toContain("windowStart=2026-05-19T13:00:00Z");
      expect(message).toContain("windowEnd=2026-05-19T16:00:00Z");
      expect(message).toContain("absenceSignal=true");
      expect(message).toContain("confidence=high");
      expect(message).toContain(
        "caption='kann jemand annehmen? bin nicht da'",
      );
      expect(message).not.toMatch(/please confirm/);

      expect(options.state).toEqual<TelegramChannelState>({
        chatId: 42,
        isGroup: false,
        fromUserId: 99,
        fromLanguageCode: "de",
      });
    });

    it("appends a please-confirm suffix when the tracking-page vision tool returns low confidence", async () => {
      const { deps, sendToAsh, parseTrackingPage } = buildDeps({
        parsedTrackingPage: {
          carrier: "unknown",
          confidence: "low",
          reason: "carrier logo cropped",
        },
      });

      const update = {
        update_id: 101,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 99, is_bot: false, first_name: "T" },
          photo: [{ file_id: "only", file_size: 100, width: 90, height: 90 }],
        },
      };

      await processInboundTelegramUpdate(makeRequest(update), deps);

      expect(parseTrackingPage).toHaveBeenCalledTimes(1);
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[tracking page parsed]");
      expect(message).toContain("confidence=low");
      expect(message).toMatch(/please confirm with the requester/i);
    });

    it("falls back to a tracking-page-flavoured parse-failure message when parseTrackingPage returns null", async () => {
      const { deps, sendToAsh, parseLabel, parseTrackingPage } = buildDeps({
        parsedTrackingPage: null,
      });

      const update = {
        update_id: 102,
        message: {
          message_id: 3,
          date: 1,
          caption: "kannst du das lesen?",
          chat: { id: 42, type: "private" },
          from: { id: 99, is_bot: false, first_name: "T" },
          photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
        },
      };

      await processInboundTelegramUpdate(makeRequest(update), deps);

      expect(parseTrackingPage).toHaveBeenCalledTimes(1);
      expect(parseLabel).not.toHaveBeenCalled();
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain(
        "[photo received, tracking page could not be parsed]",
      );
      expect(message).toContain("caption: kannst du das lesen?");
      expect(message).toMatch(/carrier and expected delivery window/i);
    });

    it("falls back to the tracking-page parse-failure message when parseTrackingPage throws", async () => {
      const { deps, sendToAsh, parseTrackingPage } = buildDeps();
      parseTrackingPage.mockRejectedValueOnce(
        new Error("vision provider down"),
      );

      const update = {
        update_id: 103,
        message: {
          message_id: 4,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 99, is_bot: false, first_name: "T" },
          photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
        },
      };

      await processInboundTelegramUpdate(makeRequest(update), deps);

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain(
        "[photo received, tracking page could not be parsed]",
      );
    });

    it("falls back to the tracking-page parse-failure message when getFileUrl throws (DM photo)", async () => {
      const { deps, sendToAsh, parseLabel, parseTrackingPage, getFileUrl } =
        buildDeps();
      getFileUrl.mockRejectedValueOnce(new Error("Bot API 404"));

      const update = {
        update_id: 104,
        message: {
          message_id: 5,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 99, is_bot: false, first_name: "T" },
          photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
        },
      };

      await processInboundTelegramUpdate(makeRequest(update), deps);

      expect(parseTrackingPage).not.toHaveBeenCalled();
      expect(parseLabel).not.toHaveBeenCalled();
      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain(
        "[photo received, tracking page could not be parsed]",
      );
    });

    it("omits absent tracking-page fields from the synthetic message", async () => {
      const { deps, sendToAsh } = buildDeps({
        parsedTrackingPage: {
          carrier: "DHL",
          // No trackingNumber, no window, no absenceSignal.
          confidence: "medium",
          reason: "only carrier legible",
        },
      });

      const update = {
        update_id: 105,
        message: {
          message_id: 6,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 99, is_bot: false, first_name: "T" },
          photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
        },
      };

      await processInboundTelegramUpdate(makeRequest(update), deps);

      const [message] = sendToAsh.mock.calls[0]!;
      expect(message).toContain("[tracking page parsed]");
      expect(message).toContain("carrier=DHL");
      expect(message).not.toContain("trackingNumber=");
      expect(message).not.toContain("windowStart=");
      expect(message).not.toContain("windowEnd=");
      expect(message).not.toContain("absenceSignal=");
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

  it("synthesizes an accept_reception_request message when 'accept_reception_request:req_99' is tapped", async () => {
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
    expect(text).toMatch(/accept.*reception.*req_99/i);
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

  describe("accept_reception_group (Flow 2 v2)", () => {
    it("synthesizes the full 5-step accept procedure when a registered resident taps the group card", async () => {
      const { deps, sendToAsh, stripKeyboard, isRegisteredResident } =
        buildDeps({ isRegisteredResident: true });

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

      expect(isRegisteredResident).toHaveBeenCalledWith(99);
      expect(stripKeyboard).toHaveBeenCalledWith(-100123, 555);
      expect(sendToAsh).toHaveBeenCalledTimes(1);
      const [text] = sendToAsh.mock.calls[0]!;
      expect(text).toMatch(/accept_reception_request/);
      expect(text).toMatch(/requestId=req_42/);
      expect(text).toMatch(/edit_group_card/);
      expect(text).toMatch(/groupCardChatId/);
      expect(text).toMatch(/req_42/);
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
    // And explicitly tell it not to call create_reception_request etc. so
    // we close the v2 regression (#85) where the agent fired tools across
    // multiple flows.
    expect(message).toContain("create_reception_request");
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
