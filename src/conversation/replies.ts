import type { StoredMessage } from "../db/repo/messages";
import { textWithTags } from "./mentions";

/** How much of a replied-to message a reply shows inside the history (Telegram's reply header). */
export const REPLY_START_CHARS = 100;

/** What a reply replies to, as models are shown it. */
export type ReplyTarget = { fromName: string; isBot: boolean; text: string; entities: unknown[] | null; label: string | null };

/** A message as models read it: tags marked (see textWithTags), then its media label. */
export function messageBody(m: { text: string; entities: unknown[] | null; label: string | null }): string {
  const text = textWithTags(m.text, m.entities);
  return m.label ? `${text} [${m.label}]`.trim() : text;
}

/** A stored row as a reply target. */
export function asTarget(r: StoredMessage): ReplyTarget {
  return { fromName: r.fromName, isBot: r.isBot, text: r.text, entities: r.entities, label: r.media?.label ?? null };
}

/**
 * What `r` replies to: the stored row when `known` holds it (it may have been edited since),
 * else the copy Telegram sent with the reply (a bakery card, a notice, a message pruned or sent
 * before the bot joined). A copy from before the group's "forget" stays forgotten; rows in
 * `known` are expected to be after it already. Null when `r` isn't a reply.
 */
export function replyTargetOf(
  r: StoredMessage,
  known: Map<number, StoredMessage>,
  forgetBefore: Date | null,
): ReplyTarget | null {
  if (r.replyToId == null) return null;
  const row = known.get(r.replyToId);
  if (row) return asTarget(row);
  const copy = r.repliedTo;
  if (!copy || (forgetBefore && new Date(copy.date) <= forgetBefore)) return null;
  return { fromName: copy.fromName, isBot: copy.isBot, text: copy.text, entities: copy.entities, label: copy.label };
}

/**
 * The start of a text on one line, the way Telegram's reply header previews the replied-to
 * message: whitespace collapsed, cut near `max` characters (code points, so an emoji is never
 * split), at a word break when one is close, with "…" when cut.
 */
export function startOf(text: string, max = REPLY_START_CHARS): string {
  const flat = oneLine(text);
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The text on one line (a quote can span lines; transcript lines can't). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
