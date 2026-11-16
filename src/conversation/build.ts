import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { StoredMessage } from "../db/repo/messages";
import { log } from "../util/log";
import { israelTime } from "../util/time";
import { textWithTags } from "./mentions";

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

function humanBlocks(r: StoredMessage, attach: Map<number, Attach>): Block[] {
  const att = attach.get(r.messageId);
  const label = r.media ? ` [${esc(r.media.label)}${att ? " attached" : ""}]` : "";
  const reply = r.replyToId != null ? ` reply_to="${r.replyToId}"` : "";
  const text = `<msg id="${r.messageId}" from="${escAttr(r.fromName)}" at="${israelTime(r.date)}"${reply}>${esc(textWithTags(r.text, r.entities))}${label}</msg>`;
  const blocks: Block[] = [{ type: "text", text }];
  if (att) blocks.push({ type: att.type, source: { type: "file", file_id: att.fileId } });
  return blocks;
}

/**
 * The history as alternating turns. `leading` rows (focus messages from outside the window) come
 * first, each as its own <msg> in the user turn even when the bot wrote it, so the model sees
 * them. Never empty: with nothing to show, one user turn says there are no newer messages.
 */
export function buildTranscript(
  rows: StoredMessage[],
  opts: { attach: Map<number, Attach>; noNewer: string; leading?: StoredMessage[] },
): BetaMessageParam[] {
  const turns: { role: "user" | "assistant"; content: Block[] }[] = [];
  const lead = (opts.leading ?? []).flatMap((r) => humanBlocks(r, opts.attach));
  if (lead.length) turns.push({ role: "user", content: lead });
  for (const r of rows) {
    const role = r.isBot ? "assistant" : "user";
    const blocks: Block[] = r.isBot ? (r.text ? [{ type: "text", text: r.text }] : []) : humanBlocks(r, opts.attach);
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
