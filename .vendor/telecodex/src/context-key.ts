import type { Context } from "grammy";

export type TelegramContextKey = string;

export function contextKeyFromMessage(chatId: number, messageThreadId?: number): TelegramContextKey {
  if (messageThreadId !== undefined) {
    return `${chatId}:${messageThreadId}`;
  }
  return `${chatId}`;
}

export function contextKeyFromCtx(ctx: Context): TelegramContextKey | null {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    return null;
  }
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const isForumTopic = message?.is_topic_message === true ||
    (ctx.chat?.type === "supergroup" && ctx.chat.is_forum === true);
  const threadId = isForumTopic ? message?.message_thread_id : undefined;
  return contextKeyFromMessage(chatId, threadId);
}

export function parseContextKey(key: TelegramContextKey): { chatId: number; messageThreadId?: number } {
  const parts = key.split(":");
  const chatId = Number(parts[0]);
  const messageThreadId = parts[1] ? Number(parts[1]) : undefined;
  return { chatId, messageThreadId };
}

export function isTopicContextKey(key: TelegramContextKey): boolean {
  return key.includes(":");
}
