import type { Message, MessageReactionUpdated } from "grammy/types";
import { replyTarget } from "./ingest";

export type TriggerContext = {
  botId: number;
  botUsername: string;
};

/** Pure: does this message address the bot? A mention wins over a reply. */
export function detectTrigger(msg: Message, ctx: TriggerContext): "mention" | "reply" | null {
  const text = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const handle = `@${ctx.botUsername}`.toLowerCase();
  for (const e of entities) {
    if (e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle) {
      return "mention";
    }
    if (e.type === "text_mention" && e.user.id === ctx.botId) return "mention";
  }
  if (replyTarget(msg)?.from?.id === ctx.botId) return "reply";
  return null;
}

/** Pure: `emoji` was newly added by this reaction update (standard emoji only). */
export function reactionTrigger(upd: MessageReactionUpdated, emoji: string): boolean {
  const has = (list: MessageReactionUpdated["new_reaction"]) =>
    list.some((r) => r.type === "emoji" && r.emoji === emoji);
  return has(upd.new_reaction) && !has(upd.old_reaction);
}

/** Pure: the message is the /settings command (`/settings` or `/settings@<this bot>`, any case). */
export function isSettingsCommand(msg: Message, botUsername: string): boolean {
  const e = msg.entities?.[0];
  if (!msg.text || e?.type !== "bot_command" || e.offset !== 0) return false;
  const [cmd, at] = msg.text.slice(0, e.length).toLowerCase().split("@");
  return cmd === "/settings" && (at === undefined || at === botUsername.toLowerCase());
}
