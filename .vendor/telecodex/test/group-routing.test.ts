import type { Context } from "grammy";

import { groupUpdateAddressesBot } from "../src/bot.js";

const botInfo = { id: 42, is_bot: true, first_name: "TeleCodex", username: "telecodex_bot" };

describe("Telegram group addressing", () => {
  it("accepts commands, mentions, and replies to this bot", () => {
    expect(groupUpdateAddressesBot(ctx({ text: "/status" }))).toBe(true);
    expect(groupUpdateAddressesBot(ctx({ text: "@telecodex_bot 看这里" }))).toBe(true);
    expect(groupUpdateAddressesBot(ctx({
      text: "继续",
      reply_to_message: { message_id: 1, from: botInfo },
    }))).toBe(true);
    expect(groupUpdateAddressesBot({
      chat: { id: -100, type: "supergroup", title: "test" },
      callbackQuery: {
        id: "callback-1",
        chat_instance: "group",
        from: { id: 7, is_bot: false, first_name: "Ada" },
        data: `tm:${"a".repeat(32)}`,
        message: {
          message_id: 3,
          date: 0,
          chat: { id: -100, type: "supergroup", title: "test" },
          text: "Choose one",
        },
      },
      me: botInfo,
    } as unknown as Context)).toBe(true);
  });

  it("ignores ordinary group chatter and mentions of another bot", () => {
    expect(groupUpdateAddressesBot(ctx({ text: "普通群聊" }))).toBe(false);
    expect(groupUpdateAddressesBot(ctx({ text: "@other_bot 看这里" }))).toBe(false);
  });
});

function ctx(message: Record<string, unknown>): Context {
  return {
    chat: { id: -100, type: "supergroup", title: "test" },
    message: { message_id: 2, date: 0, chat: { id: -100, type: "supergroup", title: "test" }, ...message },
    me: botInfo,
  } as unknown as Context;
}
