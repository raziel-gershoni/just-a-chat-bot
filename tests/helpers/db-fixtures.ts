import type { Db } from "@/src/db/types";
import { upsertGroup } from "@/src/db/repo/groups";
import type { NewMessage } from "@/src/db/repo/messages";

export async function seedGroup(db: Db, chatId = 1) {
  await upsertGroup(db, { chatId, title: "g", settings: {}, token: `tok${chatId}` });
}

export function msg(chatId: number, messageId: number, over: Partial<NewMessage> = {}): NewMessage {
  return {
    chatId,
    messageId,
    threadId: null,
    fromId: 10,
    fromName: "u",
    isBot: false,
    date: new Date(Date.UTC(2026, 0, 1, 0, 0, messageId)),
    text: `m${messageId}`,
    entities: null,
    replyToId: null,
    media: null,
    mediaGroupId: null,
    ...over,
  };
}
