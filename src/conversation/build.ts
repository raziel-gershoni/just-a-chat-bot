import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { StoredMessage } from "../db/repo/messages";
import { israelTime } from "../util/time";

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
  const text = `<msg id="${r.messageId}" from="${escAttr(r.fromName)}" at="${israelTime(r.date)}"${reply}>${esc(r.text)}${label}</msg>`;
  const blocks: Block[] = [{ type: "text", text }];
  if (att) blocks.push({ type: att.type, source: { type: "file", file_id: att.fileId } });
  return blocks;
}

export function buildTranscript(
  rows: StoredMessage[],
  opts: { attach: Map<number, Attach>; noNewer: string },
): BetaMessageParam[] {
  const turns: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const r of rows) {
    const role = r.isBot ? "assistant" : "user";
    const blocks: Block[] = r.isBot ? (r.text ? [{ type: "text", text: r.text }] : []) : humanBlocks(r, opts.attach);
    if (blocks.length === 0) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  if (turns.length === 0) return [];
  if (turns[turns.length - 1]?.role === "assistant") {
    turns.push({ role: "user", content: [{ type: "text", text: opts.noNewer }] });
  }
  const finalBlocks = turns[turns.length - 1]!.content;
  finalBlocks[finalBlocks.length - 1]!.cache_control = { type: "ephemeral" };
  return turns as unknown as BetaMessageParam[];
}

/** Media rows worth attaching: the newest 10 rows plus the focus rows, under the size limit. */
export function pickAttachments(rows: StoredMessage[], focusIds: number[]): StoredMessage[] {
  const recent = new Set(rows.slice(-RECENT_MEDIA_WINDOW).map((r) => r.messageId));
  return rows.filter(
    (r) =>
      r.media != null &&
      ATTACHABLE.has(r.media.kind) &&
      (recent.has(r.messageId) || focusIds.includes(r.messageId)) &&
      (r.media.fileSize == null || r.media.fileSize <= MAX_FILE_BYTES),
  );
}
