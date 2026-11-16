import type { Api } from "grammy";

// The slice of grammY's Api the app uses, so tests can hand in a hand-written fake.
export type TgApi = Pick<
  Api,
  | "sendMessage"
  | "editMessageReplyMarkup"
  | "answerCallbackQuery"
  | "getChatMember"
  | "leaveChat"
  | "sendChatAction"
  | "getFile"
  | "setWebhook"
>;
