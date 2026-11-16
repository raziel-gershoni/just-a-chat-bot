import type { TgApi } from "@/src/telegram/types";

export type FakeTg = TgApi & {
  calls: { method: string; args: unknown[] }[];
  members: Map<number, string>;
};

// A hand-written Telegram API: records every call. sendMessage returns message ids from
// 1000 up; getChatMember answers from `members` (userId -> status, default "left").
export function fakeTg(): FakeTg {
  const calls: FakeTg["calls"] = [];
  const members = new Map<number, string>();
  let nextId = 1000;
  const record = (method: string, args: unknown[]) => { calls.push({ method, args }); };
  const fake = {
    calls,
    members,
    sendMessage: async (...args: unknown[]) => { record("sendMessage", args); return { message_id: nextId++ }; },
    editMessageReplyMarkup: async (...args: unknown[]) => { record("editMessageReplyMarkup", args); return true; },
    answerCallbackQuery: async (...args: unknown[]) => { record("answerCallbackQuery", args); return true; },
    getChatMember: async (...args: unknown[]) => {
      record("getChatMember", args);
      return { status: members.get(args[1] as number) ?? "left", user: { id: args[1] } };
    },
    leaveChat: async (...args: unknown[]) => { record("leaveChat", args); return true; },
    sendChatAction: async (...args: unknown[]) => { record("sendChatAction", args); return true; },
    getFile: async (...args: unknown[]) => { record("getFile", args); return { file_id: args[0], file_path: `files/${args[0]}` }; },
    setWebhook: async (...args: unknown[]) => { record("setWebhook", args); return true; },
  };
  return fake as unknown as FakeTg;
}
