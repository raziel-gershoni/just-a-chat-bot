import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { StoredMessage } from "../db/repo/messages";
import { log } from "../util/log";
import { israelTime } from "../util/time";
import { textWithTags } from "./mentions";
import { messageBody, replyTargetOf, startOf, type ReplyTarget } from "./replies";

export type Attach = { type: "image" | "document"; fileId: string };

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RECENT_MEDIA_WINDOW = 10;
const ATTACHABLE = new Set(["photo", "pdf", "sticker"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Attribute values are quoted, so quotes must not break out of them either.
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

type Block = Record<string, unknown>;

type Ctx = {
  attach: Map<number, Attach>;
  /** Every row in the request (window and leading), by message id: where replies find their target. */
  known: Map<number, StoredMessage>;
  forgetBefore: Date | null;
};

// Who wrote a replied-to message: the bot's own is marked with an attribute no member name can
// produce.
const author = (t: ReplyTarget) => (t.isBot ? 'self="true"' : `from="${escAttr(t.fromName)}"`);

// What a reply answers, the way Telegram's reply header shows it. A reply to one of the bot's
// own messages (assistant turns have no id) or to a message not in the request carries the start
// of it; a reply to another message in the request just names it by reply_to. The words the
// sender quoted come after. Rendered the same on every run, so the cached prefix stays stable.
function replyParts(r: StoredMessage, ctx: Ctx): string {
  const target = replyTargetOf(r, ctx.known, ctx.forgetBefore);
  let out = "";
  if (target && (target.isBot || !ctx.known.has(r.replyToId!))) {
    out += `<replied_to ${author(target)}>${esc(startOf(messageBody(target)))}</replied_to>`;
  }
  if (r.quote) out += `<quote>${esc(r.quote)}</quote>`;
  return out;
}

function humanBlocks(r: StoredMessage, ctx: Ctx): Block[] {
  const att = ctx.attach.get(r.messageId);
  const label = r.media ? ` [${esc(r.media.label)}${att ? " attached" : ""}]` : "";
  const reply = r.replyToId != null ? ` reply_to="${r.replyToId}"` : "";
  const text = `<msg id="${r.messageId}" from="${escAttr(r.fromName)}" at="${israelTime(r.date)}"${reply}>${replyParts(r, ctx)}${esc(textWithTags(r.text, r.entities))}${label}</msg>`;
  const blocks: Block[] = [{ type: "text", text }];
  if (att) blocks.push({ type: att.type, source: { type: "file", file_id: att.fileId } });
  return blocks;
}

/**
 * The history as alternating turns. `leading` rows (focus messages from outside the window) come
 * first, each as its own <msg> in the user turn even when the bot wrote it, so the model sees
 * them. When the message the run answers (`focus`) is a reply, the message it replies to follows
 * in full, after the cache breakpoint (it is only for this run). Never empty: with nothing to
 * show, one user turn says there are no newer messages.
 */
export function buildTranscript(
  rows: StoredMessage[],
  opts: {
    attach: Map<number, Attach>;
    noNewer: string;
    leading?: StoredMessage[];
    focus?: number;
    forgetBefore?: Date | null;
  },
): BetaMessageParam[] {
  const turns: { role: "user" | "assistant"; content: Block[] }[] = [];
  const ctx: Ctx = {
    attach: opts.attach,
    known: new Map([...(opts.leading ?? []), ...rows].map((r) => [r.messageId, r])),
    forgetBefore: opts.forgetBefore ?? null,
  };
  const lead = (opts.leading ?? []).flatMap((r) => humanBlocks(r, ctx));
  if (lead.length) turns.push({ role: "user", content: lead });
  for (const r of rows) {
    const role = r.isBot ? "assistant" : "user";
    const blocks: Block[] = r.isBot ? (r.text ? [{ type: "text", text: r.text }] : []) : humanBlocks(r, ctx);
    if (blocks.length === 0) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  if (turns.length === 0 || turns[turns.length - 1]?.role === "assistant") {
    turns.push({ role: "user", content: [{ type: "text", text: opts.noNewer }] });
  }
  const finalBlocks = turns[turns.length - 1]!.content;
  finalBlocks[finalBlocks.length - 1]!.cache_control = { type: "ephemeral" };
  const focus = opts.focus != null ? ctx.known.get(opts.focus) : undefined;
  const target = focus ? replyTargetOf(focus, ctx.known, ctx.forgetBefore) : null;
  if (focus && target) {
    finalBlocks.push({
      type: "text",
      text: `<replied_to_full msg="${focus.messageId}" ${author(target)}>${esc(messageBody(target))}</replied_to_full>`,
    });
  }
  return turns as unknown as BetaMessageParam[];
}

/** Media rows worth attaching: the newest 10 rows plus the focus rows, under the size limit. */
export function pickAttachments(rows: StoredMessage[], focusIds: number[]): StoredMessage[] {
  const recent = new Set(rows.slice(-RECENT_MEDIA_WINDOW).map((r) => r.messageId));
  return rows.filter((r) => {
    if (r.media == null || !ATTACHABLE.has(r.media.kind)) return false;
    if (!recent.has(r.messageId) && !focusIds.includes(r.messageId)) return false;
    if (r.media.fileSize != null && r.media.fileSize > MAX_FILE_BYTES) {
      log("media.too_large", { chat_id: r.chatId, message_id: r.messageId, size: r.media.fileSize, max: MAX_FILE_BYTES });
      return false;
    }
    return true;
  });
}
