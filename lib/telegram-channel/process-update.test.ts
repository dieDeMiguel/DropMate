import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "experimental-ash/channels";

import {
  processInboundTelegramUpdate,
  type ProcessUpdateDeps,
  type TelegramChannelState,
  type TelegramSessionAuth,
} from "./process-update.js";

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
  getSessionIdForChat: ReturnType<typeof vi.fn>;
  setSessionIdForChat: ReturnType<typeof vi.fn>;
  drainSession: ReturnType<typeof vi.fn>;
  getFileUrl: ReturnType<typeof vi.fn>;
  parseLabel: ReturnType<typeof vi.fn>;
  answerCallback: ReturnType<typeof vi.fn>;
  stripKeyboard: ReturnType<typeof vi.fn>;
  getPackageRecipientId: ReturnType<typeof vi.fn>;
  recordTelegramObservation: ReturnType<typeof vi.fn>;
  setTriggerAttribute: ReturnType<typeof vi.fn>;
}

type ParsedLabel = NonNullable<
  Awaited<ReturnType<ProcessUpdateDeps["parseLabel"]>>
>;

function buildDeps(overrides: {
  existingSessionId?: string | null;
  session?: Session;
  expectedSecret?: string | undefined;
  fileUrl?: string;
  parsedLabel?: ParsedLabel | null;
  packageRecipientId?: string | null;
} = {}): BuiltDeps {
  const session = overrides.session ?? makeSession("sess_new");
  const sendToAsh = vi.fn().mockResolvedValue(session);
  const waitUntil = vi.fn();
  const getSessionIdForChat = vi
    .fn()
    .mockResolvedValue(overrides.existingSessionId ?? null);
  const setSessionIdForChat = vi.fn().mockResolvedValue(undefined);
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
  const answerCallback = vi.fn().mockResolvedValue(undefined);
  const stripKeyboard = vi.fn().mockResolvedValue(undefined);
  const getPackageRecipientId = vi
    .fn()
    .mockResolvedValue(
      "packageRecipientId" in overrides ? overrides.packageRecipientId : null,
    );
  const recordTelegramObservation = vi.fn().mockResolvedValue(undefined);
  const setTriggerAttribute = vi.fn();
  return {
    sendToAsh,
    waitUntil,
    getSessionIdForChat,
    setSessionIdForChat,
    drainSession,
    getFileUrl,
    parseLabel,
    answerCallback,
    stripKeyboard,
    getPackageRecipientId,
    recordTelegramObservation,
    setTriggerAttribute,
    deps: {
      expectedSecret:
        "expectedSecret" in overrides ? overrides.expectedSecret : SECRET,
      sendToAsh: sendToAsh as ProcessUpdateDeps["sendToAsh"],
      waitUntil,
      getSessionIdForChat,
      setSessionIdForChat,
      drainSession,
      getFileUrl,
      parseLabel,
      answerCallback,
      stripKeyboard,
      getPackageRecipientId,
      recordTelegramObservation,
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

  it("creates a new session, persists the session id, and backgrounds the drain", async () => {
    const session = makeSession("sess_abc");
    const { deps, sendToAsh, getSessionIdForChat, setSessionIdForChat, waitUntil, drainSession } =
      buildDeps({ existingSessionId: null, session });

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "Hallo", fromUserId: 99, languageCode: "de" }),
      ),
      deps,
    );

    expect(res.status).toBe(204);

    expect(getSessionIdForChat).toHaveBeenCalledWith(42);

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

    expect(setSessionIdForChat).toHaveBeenCalledWith(42, "sess_abc");
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The backgrounded task is the drain — invoking it should not throw.
    await waitUntil.mock.calls[0]![0];
    expect(drainSession).toHaveBeenCalledWith(session, 42);
  });

  it("reuses an existing session id as the continuation token without re-persisting", async () => {
    const session = makeSession("sess_existing");
    const { deps, sendToAsh, setSessionIdForChat } = buildDeps({
      existingSessionId: "sess_existing",
      session,
    });

    const res = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 7, text: "follow-up", fromUserId: 99 })),
      deps,
    );

    expect(res.status).toBe(204);
    const options = sendToAsh.mock.calls[0]![1];
    expect(options.continuationToken).toBe("sess_existing");
    expect(setSessionIdForChat).not.toHaveBeenCalled();
  });

  it("re-pins the chatId→sessionId mapping when the Ash channel returns a new session id (zombie eviction)", async () => {
    // Reproduces the production bug: Redis holds a stale sessionId from a
    // failed turn; the Ash channel silently spawns a new session via
    // runtime.run(...) and returns the new id. Without re-pinning, every
    // subsequent turn restarts a context-free session.
    const replacement = makeSession("sess_fresh");
    const { deps, sendToAsh, setSessionIdForChat } = buildDeps({
      existingSessionId: "sess_zombie",
      session: replacement,
    });

    const res = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 7, text: "follow-up", fromUserId: 99 })),
      deps,
    );

    expect(res.status).toBe(204);
    const options = sendToAsh.mock.calls[0]![1];
    expect(options.continuationToken).toBe("sess_zombie");
    expect(setSessionIdForChat).toHaveBeenCalledWith(7, "sess_fresh");
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

  it("parses the label via parseLabel and forwards a synthetic text message naming the extracted fields", async () => {
    const fileUrl =
      "https://api.telegram.org/file/bot111:AAA/photos/file_99.jpg";
    const { deps, sendToAsh, getFileUrl, parseLabel } = buildDeps({
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

    // parseLabel receives the URL + caption — no bytes, no mediaType. The
    // Gateway server fetches the URL itself; passing inline bytes would
    // make the Gateway client emit a `data:` URI the server rejects.
    expect(parseLabel).toHaveBeenCalledTimes(1);
    const parseArgs = parseLabel.mock.calls[0]![0];
    expect(parseArgs.imageUrl).toBe(fileUrl);
    expect(parseArgs.caption).toBe("Paket für Natascha");
    expect(parseArgs.imageBase64).toBeUndefined();
    expect(parseArgs.mediaType).toBeUndefined();

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
      isGroup: false,
      fromUserId: 99,
      fromLanguageCode: "de",
    });
  });

  it("substitutes a placeholder caption when a photo arrives without text", async () => {
    const { deps, sendToAsh, getFileUrl, parseLabel } = buildDeps();

    const update = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 42, type: "private" },
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

  it("appends a please-confirm suffix when the vision tool returns low confidence", async () => {
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
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "only", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("confidence=low");
    expect(message).toMatch(/please confirm/i);
  });

  it("falls back to a generic 'photo received, label could not be parsed' message when parseLabel returns null", async () => {
    const { deps, sendToAsh, parseLabel } = buildDeps({ parsedLabel: null });

    const update = {
      update_id: 4,
      message: {
        message_id: 4,
        date: 1,
        caption: "kann das jemand lesen?",
        chat: { id: 42, type: "private" },
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

  it("falls back to the parse-failure message when parseLabel throws", async () => {
    const { deps, sendToAsh, parseLabel } = buildDeps();
    parseLabel.mockRejectedValueOnce(new Error("vision provider down"));

    const update = {
      update_id: 5,
      message: {
        message_id: 5,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[photo received, label could not be parsed]");
  });

  it("falls back to the parse-failure message when getFileUrl throws", async () => {
    const { deps, sendToAsh, parseLabel, getFileUrl } = buildDeps();
    getFileUrl.mockRejectedValueOnce(new Error("Bot API 404"));

    const update = {
      update_id: 6,
      message: {
        message_id: 6,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "T" },
        photo: [{ file_id: "f", file_size: 100, width: 90, height: 90 }],
      },
    };

    await processInboundTelegramUpdate(makeRequest(update), deps);

    expect(parseLabel).not.toHaveBeenCalled();
    const [message] = sendToAsh.mock.calls[0]!;
    expect(message).toContain("[photo received, label could not be parsed]");
  });

  it("omits absent label fields from the synthetic message", async () => {
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
        chat: { id: 42, type: "private" },
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
      buildDeps({ existingSessionId: "sess_cb", session });

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
    expect(options.continuationToken).toBe("sess_cb");
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

  it("persists a new session id when no session existed for the chat", async () => {
    const session = makeSession("sess_new_cb");
    const { deps, setSessionIdForChat } = buildDeps({
      existingSessionId: null,
      session,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({ chatId: 42, messageId: 1, fromUserId: 99, data: "confirm_pickup:pkg_1" }),
      ),
      deps,
    );

    expect(setSessionIdForChat).toHaveBeenCalledWith(42, "sess_new_cb");
  });

  it("re-pins the chatId→sessionId mapping on a callback tap when the Ash channel returns a fresh session id", async () => {
    const replacement = makeSession("sess_fresh_cb");
    const { deps, setSessionIdForChat } = buildDeps({
      existingSessionId: "sess_zombie_cb",
      session: replacement,
    });

    await processInboundTelegramUpdate(
      makeRequest(
        cbUpdate({ chatId: 42, messageId: 1, fromUserId: 99, data: "confirm_pickup:pkg_1" }),
      ),
      deps,
    );

    expect(setSessionIdForChat).toHaveBeenCalledWith(42, "sess_fresh_cb");
  });

  it("synthesizes an accept_reception_request message when 'accept_reception_request:req_99' is tapped", async () => {
    const { deps, sendToAsh } = buildDeps({ existingSessionId: "sess_x" });
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
    const { deps, sendToAsh } = buildDeps({ existingSessionId: "sess_x" });
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
      existingSessionId: "sess_grp",
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
    const { deps, sendToAsh, getPackageRecipientId } = buildDeps({
      existingSessionId: "sess_dm",
    });

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
      existingSessionId: "sess_x",
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
    const { deps, sendToAsh, answerCallback, stripKeyboard } = buildDeps({
      existingSessionId: "sess_x",
    });
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
    const { deps, sendToAsh } = buildDeps({ existingSessionId: "sess_x" });
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
});

describe("processInboundTelegramUpdate — trace integration (#58)", () => {
  it("emits a `webhook.start` event inside the surrounding runWithTrace scope", async () => {
    // Import dynamically to avoid leaking subscribers into the
    // top-level test scope (the trace bus is process-wide).
    const { runWithTrace, subscribe } = await import("../trace.js");
    const events: Array<{ stage: string; phase: string; traceId: string }> = [];
    const unsubscribe = subscribe((e) =>
      events.push({ stage: e.stage, phase: e.phase, traceId: e.traceId }),
    );

    try {
      const { deps } = buildDeps();
      await runWithTrace(
        { traceId: "trace_smoke", kind: "text" },
        () =>
          processInboundTelegramUpdate(
            makeRequest(dmUpdate({ chatId: 17, text: "hi", fromUserId: 99 })),
            deps,
          ),
      );

      // The orchestrator's first action is `emitTrace("webhook", "start")`.
      // Any future per-stage emits (#59/#60/#61) just add entries; this
      // assertion only cares the smoke-test signal fires.
      const smokeEvents = events.filter((e) => e.traceId === "trace_smoke");
      expect(smokeEvents.length).toBeGreaterThanOrEqual(1);
      expect(smokeEvents[0]).toMatchObject({
        stage: "webhook",
        phase: "start",
        traceId: "trace_smoke",
      });
    } finally {
      unsubscribe();
    }
  });

  it("is a silent no-op when called without a surrounding trace scope", async () => {
    const { subscribe } = await import("../trace.js");
    const events: unknown[] = [];
    const unsubscribe = subscribe((e) => events.push(e));

    try {
      const { deps } = buildDeps();
      // No `runWithTrace` wrapper — the orchestrator's emitTrace call
      // must be a no-op so this code path is safe in cron schedules,
      // the built-in Ash API channel, and unit tests that don't care.
      await processInboundTelegramUpdate(
        makeRequest(dmUpdate({ chatId: 18, text: "hi", fromUserId: 100 })),
        deps,
      );
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});

describe("processInboundTelegramUpdate — V1 per-stage trace (#59)", () => {
  async function recordStages(
    setup: (deps: BuiltDeps["deps"]) => Promise<unknown>,
    buildOverrides?: Parameters<typeof buildDeps>[0],
  ): Promise<string[]> {
    const { runWithTrace, subscribe } = await import("../trace.js");
    const stages: string[] = [];
    const unsubscribe = subscribe((e) => {
      if (e.traceId !== "trace_stages") return;
      stages.push(`${e.stage}.${e.phase}`);
    });
    try {
      const { deps } = buildDeps(buildOverrides);
      await runWithTrace({ traceId: "trace_stages", kind: "text" }, () =>
        setup(deps),
      );
      return stages;
    } finally {
      unsubscribe();
    }
  }

  it("emits webhook.start → orchestrator.start → ash_send.start/end → orchestrator.end for a text DM", async () => {
    const stages = await recordStages((deps) =>
      processInboundTelegramUpdate(
        makeRequest(dmUpdate({ chatId: 17, text: "hi", fromUserId: 99 })),
        deps,
      ),
    );

    expect(stages).toEqual([
      "webhook.start",
      "orchestrator.start",
      "ash_send.start",
      "ash_send.end",
      "orchestrator.end",
    ]);
  });

  it("emits orchestrator.end even when an update is unhandled (no inbound, no callback)", async () => {
    // Empty update — neither `message` nor `callback_query`. The
    // orchestrator should still pair start/end so the diagram engine
    // doesn't stall waiting for an end event.
    const stages = await recordStages((deps) =>
      processInboundTelegramUpdate(
        makeRequest({ update_id: 99 } as unknown),
        deps,
      ),
    );

    expect(stages).toContain("webhook.start");
    expect(stages).toContain("orchestrator.start");
    expect(stages).toContain("orchestrator.end");
    // No ash_send on this branch.
    expect(stages.some((s) => s.startsWith("ash_send"))).toBe(false);
  });

  it("does NOT emit ash_send or orchestrator.end on a bad-secret short-circuit", async () => {
    const { runWithTrace, subscribe } = await import("../trace.js");
    const stages: string[] = [];
    const unsubscribe = subscribe((e) => {
      if (e.traceId !== "trace_bad_secret") return;
      stages.push(`${e.stage}.${e.phase}`);
    });
    try {
      const { deps } = buildDeps();
      await runWithTrace(
        { traceId: "trace_bad_secret", kind: "text" },
        () =>
          processInboundTelegramUpdate(
            makeRequest(dmUpdate({ chatId: 1, text: "hi" }), "wrong"),
            deps,
          ),
      );
      // The webhook.start fires before the secret check (so the diagram
      // ignites for rejected webhooks too); orchestrator.start fires
      // only after verify + JSON parse succeed.
      expect(stages).toEqual(["webhook.start"]);
    } finally {
      unsubscribe();
    }
  });

  it("emits parse_label.start/end around the vision call on a photo turn", async () => {
    const photoUpdate = {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "Test" },
        photo: [
          { file_id: "AgAC1", file_unique_id: "u1", width: 320, height: 240, file_size: 100 },
        ],
      },
    };
    const stages = await recordStages((deps) =>
      processInboundTelegramUpdate(makeRequest(photoUpdate), deps),
    );

    expect(stages).toContain("parse_label.start");
    expect(stages).toContain("parse_label.end");
  });

  it("emits parse_label.error when the vision tool throws (no parse_label.end)", async () => {
    const photoUpdate = {
      update_id: 3,
      message: {
        message_id: 3,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "Test" },
        photo: [
          { file_id: "AgAC2", file_unique_id: "u2", width: 320, height: 240, file_size: 100 },
        ],
      },
    };
    const { runWithTrace, subscribe } = await import("../trace.js");
    const stages: string[] = [];
    const unsubscribe = subscribe((e) => {
      if (e.traceId !== "trace_parse_err") return;
      stages.push(`${e.stage}.${e.phase}`);
    });
    try {
      const built = buildDeps();
      built.parseLabel.mockRejectedValueOnce(new Error("vision down"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await runWithTrace(
          { traceId: "trace_parse_err", kind: "text" },
          () => processInboundTelegramUpdate(makeRequest(photoUpdate), built.deps),
        );
      } finally {
        errorSpy.mockRestore();
      }
      expect(stages).toContain("parse_label.start");
      expect(stages).toContain("parse_label.error");
      expect(stages).not.toContain("parse_label.end");
    } finally {
      unsubscribe();
    }
  });
});

describe("processInboundTelegramUpdate — trigger attribute (#74)", () => {
  /**
   * The three inbound shapes the channel routes each get a distinct
   * `trigger` value so Vercel's Agent Runs view can populate the
   * Trigger column with finer granularity than the channel's
   * `kindHint: "telegram"` alone provides. The attribute is set BEFORE
   * `sendToAsh` so the value lands on the active OTel span ahead of
   * the turn span being opened by the harness.
   */

  it("sets trigger=telegram-message for a plain text DM", async () => {
    const { deps, setTriggerAttribute, sendToAsh } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "hi", fromUserId: 99, languageCode: "de" }),
      ),
      deps,
    );

    expect(setTriggerAttribute).toHaveBeenCalledTimes(1);
    expect(setTriggerAttribute).toHaveBeenCalledWith("telegram-message");
    // Fires before sendToAsh so the value lands on the active span
    // ahead of the turn span being opened.
    const setOrder = setTriggerAttribute.mock.invocationCallOrder[0]!;
    const sendOrder = sendToAsh.mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(sendOrder);
  });

  it("sets trigger=telegram-callback for an inline-keyboard button tap", async () => {
    const { deps, setTriggerAttribute, sendToAsh } = buildDeps({
      existingSessionId: "sess_cb",
    });

    const cbUpdate = {
      update_id: 200,
      callback_query: {
        id: "cb_t",
        data: "confirm_pickup:pkg_1",
        from: {
          id: 99,
          is_bot: false,
          first_name: "T",
        },
        message: {
          message_id: 555,
          chat: { id: 42, type: "private" },
        },
      },
    };

    await processInboundTelegramUpdate(makeRequest(cbUpdate), deps);

    expect(setTriggerAttribute).toHaveBeenCalledTimes(1);
    expect(setTriggerAttribute).toHaveBeenCalledWith("telegram-callback");
    const setOrder = setTriggerAttribute.mock.invocationCallOrder[0]!;
    const sendOrder = sendToAsh.mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(sendOrder);
  });

  it("sets trigger=telegram-photo for a photo update (with or without caption)", async () => {
    const { deps, setTriggerAttribute, sendToAsh } = buildDeps();

    const photoUpdate = {
      update_id: 300,
      message: {
        message_id: 1,
        date: 1,
        caption: "Paket für Natascha",
        chat: { id: 42, type: "private" },
        from: { id: 99, is_bot: false, first_name: "T", language_code: "de" },
        photo: [
          { file_id: "small", file_size: 100, width: 90, height: 90 },
          { file_id: "large", file_size: 5000, width: 1280, height: 1280 },
        ],
      },
    };

    await processInboundTelegramUpdate(makeRequest(photoUpdate), deps);

    expect(setTriggerAttribute).toHaveBeenCalledTimes(1);
    expect(setTriggerAttribute).toHaveBeenCalledWith("telegram-photo");
    const setOrder = setTriggerAttribute.mock.invocationCallOrder[0]!;
    const sendOrder = sendToAsh.mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(sendOrder);
  });

  it("does not call setTriggerAttribute on a malformed / no-message update (no turn started)", async () => {
    const { deps, setTriggerAttribute } = buildDeps();

    await processInboundTelegramUpdate(
      makeRequest({ update_id: 7, edited_message: { message_id: 1 } }),
      deps,
    );

    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("does not call setTriggerAttribute when the secret-token header is wrong", async () => {
    const { deps, setTriggerAttribute } = buildDeps();

    const res = await processInboundTelegramUpdate(
      makeRequest(dmUpdate({ chatId: 1, text: "hi" }), "wrong"),
      deps,
    );

    expect(res.status).toBe(401);
    expect(setTriggerAttribute).not.toHaveBeenCalled();
  });

  it("tolerates a missing setTriggerAttribute dep without throwing (optional)", async () => {
    const built = buildDeps();
    // Strip the attribute setter — the orchestrator must continue
    // working unchanged when callers opt out of OTel attribution.
    const depsWithoutAttr: ProcessUpdateDeps = {
      ...built.deps,
      setTriggerAttribute: undefined,
    };

    const res = await processInboundTelegramUpdate(
      makeRequest(
        dmUpdate({ chatId: 42, text: "hi", fromUserId: 99 }),
      ),
      depsWithoutAttr,
    );

    expect(res.status).toBe(204);
    expect(built.sendToAsh).toHaveBeenCalledTimes(1);
  });
});
