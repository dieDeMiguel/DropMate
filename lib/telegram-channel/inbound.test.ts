import { describe, expect, it } from "vitest";

import {
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
      photoFileId: null,
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
});
