import type { Message } from "grammy/types";
import { pickLang, t } from "../i18n";
import { sendText } from "../telegram/send";
import type { BotDeps } from "./dispatch";

export async function handlePrivateMessage(msg: Message, deps: BotDeps): Promise<void> {
  await sendText(deps.tg, msg.chat.id, t(pickLang(msg.from?.language_code), "groupsOnly"));
}
