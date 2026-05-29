import { describe, expect, it } from "vitest";

import {
  extractInboundCallback,
  extractInboundMessage,
  type TelegramUpdatePayload,
} from "./inbound.js";

function makeUpdate(overrides: Partial<TelegramUpdatePayload["message"]> = {}): TelegramUpdatePayload {
  return {
    update_id: 1,
    message: {
      chat: { id: 100, type: "private" },
      text: "hello",
      from: { id: 200, language_code: "en" },
      ...overrides,
    },
  };
}

describe("extractInboundMessage", () => {
  it("narrows a private text DM to the canonical inbound shape", () => {
    expect(extractInboundMessage(makeUpdate())).toEqual({
      chatId: 100,
      text: "hello",
      isGroup: false,
      fromUserId: 200,
      fromLanguageCode: "en",
      fromFirstName: null,
      fromLastName: null,
      fromUsername: null,
      photoFileId: null,
    });
  });

  it("flags supergroup chats as group messages", () => {
    const update = makeUpdate({ chat: { id: -42, type: "supergroup" } });
    expect(extractInboundMessage(update)).toMatchObject({
      chatId: -42,
      isGroup: true,
    });
  });

  it("flags plain group chats as group messages", () => {
    const update = makeUpdate({ chat: { id: -42, type: "group" } });
    expect(extractInboundMessage(update)).toMatchObject({
      isGroup: true,
    });
  });

  it("returns null when there is no message (e.g. edited_message, channel_post)", () => {
    expect(extractInboundMessage({ update_id: 2 })).toBeNull();
  });

  it("returns null when the message has no text and no photo (stickers, …)", () => {
    const update: TelegramUpdatePayload = {
      update_id: 3,
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 200 },
      },
    };
    expect(extractInboundMessage(update)).toBeNull();
  });

  it("returns null when the text is empty and there is no photo", () => {
    const update = makeUpdate({ text: "" });
    expect(extractInboundMessage(update)).toBeNull();
  });

  it("falls back to nullable fromUserId / fromLanguageCode when absent", () => {
    const update: TelegramUpdatePayload = {
      update_id: 4,
      message: {
        chat: { id: 100, type: "private" },
        text: "hello",
        // no `from` (anonymous group admin)
      },
    };
    expect(extractInboundMessage(update)).toEqual({
      chatId: 100,
      text: "hello",
      isGroup: false,
      fromUserId: null,
      fromLanguageCode: null,
      fromFirstName: null,
      fromLastName: null,
      fromUsername: null,
      photoFileId: null,
    });
  });

  it("captures first_name / last_name / username when present (#45 passive directory)", () => {
    const update: TelegramUpdatePayload = {
      update_id: 99,
      message: {
        chat: { id: 100, type: "supergroup" },
        text: "moin",
        from: {
          id: 4242,
          language_code: "de",
          first_name: "Anna",
          last_name: "Müller",
          username: "diego_demiguel",
        },
      },
    };
    expect(extractInboundMessage(update)).toMatchObject({
      fromUserId: 4242,
      fromFirstName: "Anna",
      fromLastName: "Müller",
      fromUsername: "diego_demiguel",
    });
  });

  it("preserves leading slash so the model sees the raw slash command", () => {
    const update = makeUpdate({ text: "/register Anna" });
    expect(extractInboundMessage(update)?.text).toBe("/register Anna");
  });

  it("admits a photo-only update and exposes the largest variant's file_id", () => {
    const update: TelegramUpdatePayload = {
      update_id: 5,
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 200, language_code: "de" },
        photo: [
          { file_id: "small", file_size: 1234, width: 90, height: 90 },
          { file_id: "medium", file_size: 5678, width: 320, height: 320 },
          { file_id: "large", file_size: 9999, width: 1280, height: 1280 },
        ],
      },
    };
    expect(extractInboundMessage(update)).toEqual({
      chatId: 100,
      text: "",
      isGroup: false,
      fromUserId: 200,
      fromLanguageCode: "de",
      fromFirstName: null,
      fromLastName: null,
      fromUsername: null,
      photoFileId: "large",
    });
  });

  it("uses caption text alongside a photo", () => {
    const update: TelegramUpdatePayload = {
      update_id: 6,
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 200 },
        caption: "Paket für Meyer",
        photo: [{ file_id: "only", file_size: 100, width: 90, height: 90 }],
      },
    };
    expect(extractInboundMessage(update)).toMatchObject({
      text: "Paket für Meyer",
      photoFileId: "only",
    });
  });

  it("falls back to the last photo variant when file_size is missing on every variant", () => {
    const update: TelegramUpdatePayload = {
      update_id: 7,
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 200 },
        photo: [
          { file_id: "small", width: 90, height: 90 },
          { file_id: "medium", width: 320, height: 320 },
          { file_id: "large", width: 1280, height: 1280 },
        ],
      },
    };
    expect(extractInboundMessage(update)?.photoFileId).toBe("large");
  });

  it("returns null when the update is a callback_query (handled by extractInboundCallback)", () => {
    const update: TelegramUpdatePayload = {
      update_id: 8,
      callback_query: {
        id: "cb1",
        data: "confirm_pickup:pkg_42",
        from: { id: 200, language_code: "de" },
        message: {
          message_id: 555,
          chat: { id: 100, type: "private" },
        },
      },
    };
    expect(extractInboundMessage(update)).toBeNull();
  });
});

describe("extractInboundCallback", () => {
  it("narrows a private callback_query into the canonical shape", () => {
    const update: TelegramUpdatePayload = {
      update_id: 1,
      callback_query: {
        id: "cb_abc",
        data: "confirm_pickup:pkg_42",
        from: { id: 200, language_code: "de" },
        message: {
          message_id: 555,
          chat: { id: 100, type: "private" },
        },
      },
    };
    expect(extractInboundCallback(update)).toEqual({
      callbackId: "cb_abc",
      chatId: 100,
      messageId: 555,
      fromUserId: 200,
      fromLanguageCode: "de",
      fromFirstName: null,
      fromLastName: null,
      fromUsername: null,
      isGroup: false,
      data: "confirm_pickup:pkg_42",
    });
  });

  it("flags supergroup callback_query as group", () => {
    const update: TelegramUpdatePayload = {
      update_id: 2,
      callback_query: {
        id: "cb_grp",
        data: "confirm_pickup:pkg_42",
        from: { id: 200 },
        message: {
          message_id: 5,
          chat: { id: -100123, type: "supergroup" },
        },
      },
    };
    expect(extractInboundCallback(update)).toMatchObject({
      isGroup: true,
      fromLanguageCode: null,
    });
  });

  it("returns null when there is no callback_query (regular message)", () => {
    const update: TelegramUpdatePayload = {
      update_id: 3,
      message: {
        chat: { id: 100, type: "private" },
        text: "hi",
        from: { id: 200 },
      },
    };
    expect(extractInboundCallback(update)).toBeNull();
  });

  it("returns null when callback_query has no data", () => {
    const update: TelegramUpdatePayload = {
      update_id: 4,
      callback_query: {
        id: "cb_nodata",
        from: { id: 200 },
        message: {
          message_id: 5,
          chat: { id: 100, type: "private" },
        },
      },
    };
    expect(extractInboundCallback(update)).toBeNull();
  });

  it("returns null when callback_query has empty data string", () => {
    const update: TelegramUpdatePayload = {
      update_id: 5,
      callback_query: {
        id: "cb_empty",
        data: "",
        from: { id: 200 },
        message: {
          message_id: 5,
          chat: { id: 100, type: "private" },
        },
      },
    };
    expect(extractInboundCallback(update)).toBeNull();
  });

  it("returns null when callback_query has no originating message (inline mode tap)", () => {
    const update: TelegramUpdatePayload = {
      update_id: 6,
      callback_query: {
        id: "cb_inline",
        data: "foo",
        from: { id: 200 },
      },
    };
    expect(extractInboundCallback(update)).toBeNull();
  });
});
