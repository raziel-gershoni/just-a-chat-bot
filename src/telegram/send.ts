// Sending text to Telegram: Markdown answers (split, MarkdownV2 with plain fallback) and
// plain notices with optional buttons. Adapted from mail-manager's send.ts.
import telegramifyMarkdown from "telegramify-markdown";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { TgApi } from "./types";

// Telegram rejects a message over 4096 characters (counted as shown, after MarkdownV2
// parsing), so longer text goes out as several messages.
export const TELEGRAM_MAX_CHARS = 4096;
// The usual size of a part, in UTF-16 code units. The margin is for the MarkdownV2
// render, which can show more than the Markdown it came from (a "- " bullet becomes
// "•   "). messageParts cuts smaller where the margin isn't enough.
export const TELEGRAM_PART_CHARS = 3500;

const FENCE = /^ {0,3}```/;
const CLOSE_FENCE = "\n```";

// The opening line of a ``` code block that `text` leaves open, or null. The language tag
// is kept (clipped) so the reopened block highlights the same way.
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    if (!FENCE.test(line)) continue;
    open = open === null ? line.trim().slice(0, 24) : null;
  }
  return open;
}

// Where to cut `rest` (longer than `max`): the last paragraph break in the second half of
// the window, else the last line break, else the last space, else a hard cut that never
// splits an emoji's surrogate pair. `gap` is the break to drop from the next part.
function findCut(rest: string, max: number): { cut: number; gap: RegExp } {
  const window = rest.slice(0, max + 1); // +1: a break right at `max` still counts
  const late = (i: number) => i >= max / 2;
  let cut = window.lastIndexOf("\n\n");
  if (late(cut)) return { cut, gap: /^\n+/ };
  cut = window.lastIndexOf("\n");
  if (late(cut)) return { cut, gap: /^\n+/ };
  cut = window.lastIndexOf(" ");
  if (late(cut)) return { cut, gap: /^ / };
  cut = max;
  const code = rest.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't separate an emoji's halves
  return { cut: Math.max(cut, Math.min(2, rest.length)), gap: /^$/ };
}

// Cuts `text` into parts of at most `max` code units where a reader would pause (see
// findCut). A ``` code block that a cut falls inside is closed at the end of the part and
// reopened at the start of the next, so each part renders on its own. Pure.
export function splitMessage(text: string, max: number = TELEGRAM_PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let { cut, gap } = findCut(rest, max);
    let open = openFence(rest.slice(0, cut));
    // Only where the reopened fence line is small next to a part, so `rest` still shrinks.
    if (open !== null && (open.length + CLOSE_FENCE.length) * 8 < max) {
      ({ cut, gap } = findCut(rest, max - CLOSE_FENCE.length));
      open = openFence(rest.slice(0, cut));
    } else open = null;
    // Only the break itself is dropped: an indented line that starts the next part keeps
    // its indentation.
    let part = rest.slice(0, cut).trimEnd();
    rest = rest.slice(cut).replace(gap, "");
    if (open !== null) { part += CLOSE_FENCE; rest = `${open}\n${rest}`; }
    if (part) parts.push(part);
  }
  // Whitespace-only or empty text stays one part: Telegram rejects it and the caller
  // hears about it, instead of nothing being sent without a word.
  if (rest.trim() || parts.length === 0) parts.push(rest);
  return parts;
}

// How long the MarkdownV2 render of `part` is as Telegram counts it, from above: each
// escape counts once and markup characters are still counted.
function renderedLength(part: string): number {
  try {
    return telegramifyMarkdown(part, "escape").replace(/\\([\s\S])/g, "$1").length;
  } catch (err) {
    // The send falls back to plain text for this part anyway, and plain fits.
    log("telegram.render_measure_failed", { error: errorText(err) });
    return 0;
  }
}

// The parts a message is sent as: splitMessage's, with any part whose render would still
// be too long (list-heavy text) cut again at half the size. Pure.
export function messageParts(text: string, max: number = TELEGRAM_PART_CHARS): string[] {
  return splitMessage(text, max).flatMap(part =>
    max > 256 && renderedLength(part) > TELEGRAM_MAX_CHARS ? messageParts(part, Math.floor(max / 2)) : [part]);
}

// grammy surfaces Telegram's error_code on GrammyError; 429 is "slow down".
export function isRateLimited(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { error_code?: number }).error_code === 429;
}

const MD2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

// Escapes text for MarkdownV2 (every character Telegram lists as reserved).
export function escapeMd2(s: string): string {
  return s.replace(MD2_SPECIAL, "\\$&");
}

const MAX_SOURCES = 5;

function sourceTitle(s: { url: string; title: string | null }): string {
  if (s.title?.trim()) return s.title.trim().replace(/\s+/g, " ");
  try {
    return new URL(s.url).hostname;
  } catch (err) {
    log("telegram.source_url_unparsable", { error: errorText(err) });
    return s.url;
  }
}

// An expandable blockquote in MarkdownV2 listing up to 5 sources as links, or "" for none.
// Inside a link's (...) only ")" and "\" need escaping.
export function sourcesBlock(label: string, sources: { url: string; title: string | null }[]): string {
  const list = sources.slice(0, MAX_SOURCES);
  if (list.length === 0) return "";
  const lines = list.map(s =>
    `>[${escapeMd2(sourceTitle(s))}](${s.url.replace(/[)\\]/g, "\\$&")})`);
  return `**>${escapeMd2(label)}\n${lines.join("\n")}||`;
}

type ReplyOpts = { replyTo?: number; threadId?: number | null };

// Telegram parameters shared by every send: the thread, and (first part only) the reply.
function baseParams(opts: ReplyOpts, withReply: boolean) {
  return {
    ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
    ...(withReply && opts.replyTo != null
      ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
      : {}),
  };
}

// One part: rendered as MarkdownV2 (plus `tailMd2`, already escaped), or as plain text if
// conversion or the formatted send fails, so the part lands. Returns the message ids sent
// (a tail that can't ride along in the plain fallback goes as its own message). Throws if
// both sends fail. A 429 that outlasted the client's retries is thrown straight away: a
// plain send would hit the same limit.
async function sendPart(
  api: TgApi, chatId: number, text: string, tailMd2: string, opts: ReplyOpts, first: boolean,
): Promise<number[]> {
  const params = { ...baseParams(opts, first), link_preview_options: { is_disabled: true } };
  try {
    const md = telegramifyMarkdown(text, "escape").trimEnd();
    const m = await api.sendMessage(chatId, md + tailMd2, { parse_mode: "MarkdownV2", ...params });
    return [m.message_id];
  } catch (err) {
    if (isRateLimited(err)) throw err;
    log("telegram.format_fallback", { chat_id: chatId, error: errorText(err) });
    const m = await api.sendMessage(chatId, text, params);
    return tailMd2 ? [m.message_id, ...await sendTail(api, chatId, tailMd2, opts)] : [m.message_id];
  }
}

async function sendTail(api: TgApi, chatId: number, tailMd2: string, opts: ReplyOpts): Promise<number[]> {
  const m = await api.sendMessage(chatId, tailMd2.replace(/^\s+/, ""), {
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
    ...baseParams(opts, false),
  });
  return [m.message_id];
}

// Sends a Claude answer (Markdown): split into parts, each rendered as MarkdownV2 with a
// plain-text fallback. Only the first part replies to `replyTo`; all keep the thread.
// `tailMd2` (pre-escaped MarkdownV2, e.g. a sources block) is appended to the last part
// when the result fits in 4096 characters, else sent as its own message. Returns the sent
// message ids in order; throws as soon as a part can't be delivered either way (the caller
// retries the whole answer rather than leave its tail missing).
// Text goes out as toWellFormed(): a lone UTF-16 surrogate would make Telegram reject the
// whole message.
export async function sendAnswer(
  api: TgApi, chatId: number, markdown: string,
  opts: ReplyOpts & { tailMd2?: string },
): Promise<number[]> {
  const parts = messageParts(markdown.toWellFormed());
  const tail = opts.tailMd2 ? `\n\n${opts.tailMd2}` : "";
  const ids: number[] = [];
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    try {
      let attach = "";
      if (last && tail) {
        // Same measure as renderedLength: escapes count once, markup characters count.
        const shown = renderedLength(part) + tail.replace(/\\([\s\S])/g, "$1").length;
        if (shown <= TELEGRAM_MAX_CHARS) attach = tail;
      }
      ids.push(...await sendPart(api, chatId, part, attach, opts, i === 0));
      if (last && tail && !attach) ids.push(...await sendTail(api, chatId, tail, opts));
    } catch (err) {
      log("telegram.part_failed", { chat_id: chatId, part: i + 1, of: parts.length, error: errorText(err) });
      throw err;
    }
  }
  return ids;
}

export type Button = { text: string; data?: string; url?: string };

// Plain text (no parse mode, link previews off) with optional inline buttons. Doesn't
// split: the caller keeps the text under 4096 characters.
export async function sendText(
  api: TgApi, chatId: number, text: string,
  opts: ReplyOpts & { buttons?: Button[][] } = {},
): Promise<number> {
  const keyboard = opts.buttons?.map(row => row.map(b =>
    b.url !== undefined ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? "" }));
  const m = await api.sendMessage(chatId, text.toWellFormed(), {
    link_preview_options: { is_disabled: true },
    ...baseParams(opts, true),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  return m.message_id;
}
