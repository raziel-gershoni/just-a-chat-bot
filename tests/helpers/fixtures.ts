import type { Message, Update, User } from "grammy/types";

export const BOT = { id: 99, is_bot: true as const, first_name: "Bot", username: "MyBot" };
export const OWNER_ID = 7;

export function user(id: number, over: Partial<User> = {}): User {
  return { id, is_bot: false, first_name: `U${id}`, ...over };
}

let updateId = 1;
export const nextUpdateId = () => updateId++;

export function groupMsg(chatId: number, messageId: number, over: Record<string, unknown> = {}): Message {
  return {
    message_id: messageId,
    date: 1_800_000_000 + messageId,
    chat: { id: chatId, type: "supergroup", title: "Group" },
    from: user(10),
    text: `hello ${messageId}`,
    ...over,
  } as unknown as Message;
}

export function msgUpdate(message: Message): Update {
  return { update_id: nextUpdateId(), message } as Update;
}

export function reactionUpdate(
  chatId: number, messageId: number, by: User, oldE: string[], newE: string[],
): Update {
  const list = (a: string[]) => a.map((emoji) => ({ type: "emoji", emoji }));
  return {
    update_id: nextUpdateId(),
    message_reaction: {
      chat: { id: chatId, type: "supergroup", title: "Group" },
      message_id: messageId,
      user: by,
      date: 1_800_000_000,
      old_reaction: list(oldE),
      new_reaction: list(newE),
    },
  } as unknown as Update;
}

export function myChatMember(
  chatId: number, from: string, to: string, adder: User, type = "supergroup",
): Update {
  return {
    update_id: nextUpdateId(),
    my_chat_member: {
      chat: { id: chatId, type, title: "Group" },
      from: adder,
      date: 1_800_000_000,
      old_chat_member: { status: from, user: BOT },
      new_chat_member: { status: to, user: BOT },
    },
  } as unknown as Update;
}

export function chatMember(chatId: number, who: User, to: string): Update {
  return {
    update_id: nextUpdateId(),
    chat_member: {
      chat: { id: chatId, type: "supergroup", title: "Group" },
      from: who,
      date: 1_800_000_000,
      old_chat_member: { status: "member", user: who },
      new_chat_member: { status: to, user: who },
    },
  } as unknown as Update;
}
