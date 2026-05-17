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

  it("returns null when the message has no text (photos, stickers, …)", () => {
    const update: TelegramUpdatePayload = {
      update_id: 3,
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 200 },
      },
    };
    expect(extractInboundMessage(update)).toBeNull();
  });

  it("returns null when the text is empty", () => {
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
    });
  });

  it("preserves leading slash so the model sees the raw slash command", () => {
    const update = makeUpdate({ text: "/register Anna" });
    expect(extractInboundMessage(update)?.text).toBe("/register Anna");
  });
});
