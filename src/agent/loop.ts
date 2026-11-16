// One reply run, driven as a checkpointed loop: build the request snapshot once, call Claude
// step by step (each raw response is stored before anything else happens), then deliver the
// answer, the bakery proposal cards and notices, recording each send so a resumed run never
// repeats one. Called by the runner with a run it has just leased; never throws.
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { GrammyError } from "grammy";
import type { BakeryApi } from "../bakery/api";
import { postCards } from "../bakery/cards";
import { extractProposals } from "../bakery/proposals";
import { buildTranscript, pickAttachments, type Attach } from "../conversation/build";
import { ensureUploaded } from "../conversation/media";
import { getGroup, type Group } from "../db/repo/groups";
import { getMessage, insertMessage, lastBotMessageAt, windowMessages, type StoredMessage } from "../db/repo/messages";
import { finishRun, hasUserRunSince, releaseLease, saveCheckpoint, type RunRow } from "../db/repo/runs";
import type { RunSent, RunSnapshot } from "../db/schema";
import type { Db } from "../db/types";
import { t, type Lang } from "../i18n";
import type { ModelInfoLite } from "../models/catalog";
import { parseSettings, type GroupSettings } from "../settings/schema";
import { sendAnswer, sendText, sourcesBlock, type SentPart } from "../telegram/send";
import type { TgApi } from "../telegram/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import { answerSources, answerText, runBlocks } from "./answer";
import type { Llm } from "./llm";
import { contextMessage } from "./prompts";
import { buildParams, newSnapshot } from "./request";

export type LoopDeps = {
  db: Db;
  tg: TgApi;
  llm: Llm;
  /** This instance's lease owner id. */
  owner: string;
  now(): Date;
  /** Read from env by the caller; never stored. */
  bakeryCfg: { url: string; key: string } | null;
  bakery: BakeryApi | null;
  /** Bot token, for downloading Telegram files. */
  token: string;
  fetch: typeof fetch;
  models(): Promise<ModelInfoLite[]>;
  /** Shown as the sender of the bot's stored answer rows (resolved inside the run's error handling). */
  botName(): Promise<string>;
  /** Fire-and-forget; logs its own failures (the same hook the dispatcher uses for pruned rows). */
  deleteFiles(ids: string[]): void;
};

const MAX_PAUSES = 5;
/** Claims per run; counted at claim time, so a run that crashes the process also runs out. */
export const MAX_ATTEMPTS = 3;
// 4xx statuses worth retrying: timeout, conflict, rate limit.
const RETRYABLE_4XX = new Set([408, 409, 429]);

/** saveCheckpoint/finishRun found another owner on the run: stop without touching it. */
class LeaseLost extends Error {}

type Ctx = {
  run: RunRow;
  deps: LoopDeps;
  lang: Lang;
  chime: boolean;
  snap: RunSnapshot | null;
  sent: RunSent;
  steps: number;
  botName: string;
};

type End = "answer" | "cut" | "refusal" | "unexpected";

const ids = (ctx: Ctx) => ({ run_id: ctx.run.id, chat_id: ctx.run.chatId });

export async function processRun(run: RunRow, deps: LoopDeps): Promise<void> {
  const ctx: Ctx = {
    run,
    deps,
    lang: "en",
    chime: run.trigger.type === "chime",
    snap: run.snapshot,
    sent: run.sent,
    steps: run.steps,
    botName: "",
  };
  try {
    await drive(ctx);
  } catch (err) {
    try {
      if (err instanceof LeaseLost) return leaseLost(ctx);
      await onError(ctx, err);
    } catch (err2) {
      if (err2 instanceof LeaseLost) return leaseLost(ctx);
      log("run.error_handling_failed", { ...ids(ctx), error: errorText(err2), original: errorText(err) });
    }
  }
}

function leaseLost(ctx: Ctx): void {
  log("run.lease_lost", { ...ids(ctx), owner: ctx.deps.owner, steps: ctx.steps });
}

async function checkpoint(ctx: Ctx, patch: Parameters<typeof saveCheckpoint>[3]): Promise<void> {
  if (!(await saveCheckpoint(ctx.deps.db, ctx.run.id, ctx.deps.owner, patch))) throw new LeaseLost();
}

async function drive(ctx: Ctx): Promise<void> {
  const { run, deps } = ctx;
  const group = await getGroup(deps.db, run.chatId);
  if (!group?.active) {
    log("run.group_inactive", { ...ids(ctx), known: group !== null });
    if (!(await finishRun(deps.db, run.id, deps.owner, "failed", "inactive"))) throw new LeaseLost();
    return;
  }
  const settings = parseSettings(group.settings);
  ctx.lang = settings.language;
  // Attempts are counted when the run is claimed; one claim too many means earlier claims
  // never got to finish (e.g. the process died mid-run), so it stops here.
  if (run.attempts > MAX_ATTEMPTS) {
    log("run.claims_exhausted", { ...ids(ctx), attempts: run.attempts });
    return fail(ctx, `attempts_exhausted: claimed ${run.attempts} times`);
  }
  if (ctx.chime && !ctx.snap && (await chimeIsStale(ctx))) return;
  ctx.botName = await deps.botName();

  let snap = ctx.snap ?? (await buildSnapshot(ctx, group, settings));
  if (!ctx.snap) {
    ctx.snap = snap;
    await checkpoint(ctx, { snapshot: snap });
  }

  while (needsCall(snap)) {
    let msg: BetaMessage;
    try {
      msg = await deps.llm.stream(buildParams(snap, deps.bakeryCfg));
    } catch (err) {
      if (!isMcpFailure(err, snap)) throw err;
      // The connector couldn't use the bakery (e.g. a wrong key). Answer without it; the
      // flag stays for the rest of the run, so every later request is the same bytes.
      log("run.bakery_dropped", { ...ids(ctx), error: errorText(err) });
      snap = ctx.snap = { ...snap, bakeryDropped: true };
      await checkpoint(ctx, { snapshot: snap });
      continue;
    }
    logStep(ctx, msg);
    snap = ctx.snap = {
      ...snap,
      messages: [...snap.messages, { role: "assistant", content: msg.content }],
      stopReason: msg.stop_reason,
      pauseCount: snap.pauseCount + (msg.stop_reason === "pause_turn" ? 1 : 0),
    };
    ctx.steps += 1;
    await checkpoint(ctx, { snapshot: snap, steps: ctx.steps });
  }
  await finalize(ctx, snap);
}

// A chime run that waited behind other work is dropped when the bot has spoken since it was
// created, or someone has asked it something since: interjecting then would be one too many.
async function chimeIsStale(ctx: Ctx): Promise<boolean> {
  const { run, deps } = ctx;
  const lastBot = await lastBotMessageAt(deps.db, run.chatId);
  const reason =
    lastBot && lastBot > run.createdAt
      ? "bot_spoke_since"
      : (await hasUserRunSince(deps.db, run.chatId, run.createdAt))
        ? "user_run_since"
        : null;
  if (!reason) return false;
  log("run.chime_skipped", { ...ids(ctx), reason });
  if (!(await finishRun(deps.db, run.id, deps.owner, "done", `skipped: ${reason}`))) throw new LeaseLost();
  return true;
}

// The trigger's target and the message it replies to, when the history window doesn't hold
// them (older than the window), so the model always sees what it is asked about. Rows from
// before a "forget" stay forgotten.
async function focusRowsOutsideWindow(
  ctx: Ctx,
  rows: StoredMessage[],
  forgetBefore: Date | null,
): Promise<StoredMessage[]> {
  const { run, deps } = ctx;
  const inWindow = new Map(rows.map((r) => [r.messageId, r]));
  const extra: StoredMessage[] = [];
  const fetch = async (id: number | null | undefined): Promise<StoredMessage | null> => {
    if (id == null) return null;
    const known = inWindow.get(id) ?? extra.find((r) => r.messageId === id);
    if (known) return known;
    const row = await getMessage(deps.db, run.chatId, id);
    if (!row || (forgetBefore && row.date <= forgetBefore)) return null;
    extra.push(row);
    return row;
  };
  const target = await fetch(run.trigger.targetMessageId);
  await fetch(target?.replyToId);
  return extra.sort((a, b) => a.seq - b.seq);
}

async function buildSnapshot(ctx: Ctx, group: Group, settings: GroupSettings): Promise<RunSnapshot> {
  const { run, deps } = ctx;
  const trigger = run.trigger;
  const rows = await windowMessages(deps.db, {
    chatId: run.chatId,
    threadId: run.threadId,
    window: settings.historyWindow,
    after: group.forgetBefore,
  });
  const leading = await focusRowsOutsideWindow(ctx, rows, group.forgetBefore);
  if (leading.length) log("run.focus_outside_window", { ...ids(ctx), message_ids: leading.map((r) => r.messageId) });
  const all = [...leading, ...rows];
  const target = all.find((r) => r.messageId === trigger.targetMessageId);
  const focus = [trigger.messageId, trigger.targetMessageId, target?.replyToId].filter((id): id is number => id != null);
  const attach = new Map<number, Attach>();
  const uploadDeps = {
    db: deps.db,
    tg: deps.tg,
    token: deps.token,
    fetch: deps.fetch,
    upload: (buf: Buffer, name: string, mime: string) => deps.llm.upload(buf, name, mime),
  };
  for (const row of pickAttachments(all, focus)) {
    const fileId = await ensureUploaded(uploadDeps, row);
    if (fileId) attach.set(row.messageId, { type: row.media?.kind === "pdf" ? "document" : "image", fileId });
  }
  const noNewer = t(ctx.lang, "noNewerMessages");
  let transcript = buildTranscript(rows, { attach, noNewer, leading });
  if (transcript.length === 0 && target && !leading.includes(target)) {
    // Only bot rows in the window (e.g. a reaction to the bot's own message after a forget):
    // the target goes first as a message of its own, so the request is never empty.
    transcript = buildTranscript(rows.filter((r) => r !== target), { attach, noNewer, leading: [...leading, target] });
  }
  const models = await deps.models();
  const snap = newSnapshot({
    settings,
    model: models.find((m) => m.id === settings.model),
    bakeryAvailable: deps.bakeryCfg !== null,
    chime: ctx.chime,
    transcript,
    context: contextMessage({ now: deps.now(), groupTitle: group.title, trigger, chime: ctx.chime }),
  });
  log("run.built", {
    ...ids(ctx),
    trigger: trigger.type,
    rows: all.length,
    attached: attach.size,
    model: snap.model,
    effort: snap.effort,
    bakery: snap.bakery,
  });
  return snap;
}

// Call Claude when the run has no response yet, or the last one paused and continuations remain.
function needsCall(snap: RunSnapshot): boolean {
  const last = snap.messages.at(-1) as { role?: string } | undefined;
  if (last?.role !== "assistant") return true;
  return snap.stopReason === "pause_turn" && snap.pauseCount <= MAX_PAUSES;
}

function isMcpFailure(err: unknown, snap: RunSnapshot): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    /mcp/i.test(err.message) &&
    snap.bakery !== null &&
    !snap.bakeryDropped
  );
}

function logStep(ctx: Ctx, msg: BetaMessage): void {
  const results = new Map<string, boolean>();
  for (const b of msg.content) if (b.type === "mcp_tool_result") results.set(b.tool_use_id, b.is_error);
  const mcpTools = msg.content
    .filter((b) => b.type === "mcp_tool_use")
    .map((b) => ({ server: b.server_name, name: b.name, error: results.get(b.id) ?? null }));
  for (const b of msg.content) {
    if (b.type !== "mcp_tool_result" || !b.is_error) continue;
    // How the bakery's own failures (a wrong key, an outage) surface is unverified: watch for this.
    log("run.bakery_tool_error", { ...ids(ctx), tool_use_id: b.tool_use_id, text: toolResultText(b.content) });
  }
  log("run.step", {
    ...ids(ctx),
    step: ctx.steps + 1,
    stop_reason: msg.stop_reason,
    model: msg.model,
    input_tokens: msg.usage.input_tokens,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
    output_tokens: msg.usage.output_tokens,
    ...(mcpTools.length ? { mcp_tools: mcpTools } : {}),
  });
}

// The text of an MCP tool result, scrubbed of secrets and clipped for the log.
function toolResultText(content: unknown): string {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("")
        : "";
  return errorText(raw).slice(0, 500);
}

function endOf(stop: string | null | undefined): End {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn": // only here once the continuations are used up
      return "answer";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "cut";
    case "refusal":
      return "refusal";
    default:
      return "unexpected";
  }
}

async function finalize(ctx: Ctx, snap: RunSnapshot): Promise<void> {
  const { run, deps } = ctx;
  const blocks = runBlocks(snap.messages, snap.startIndex);
  const end = endOf(snap.stopReason);
  if (end === "unexpected") {
    log("run.unexpected_stop", { ...ids(ctx), stop_reason: snap.stopReason ?? null });
    return fail(ctx, `unexpected_stop: ${snap.stopReason ?? "none"}`);
  }
  if (snap.stopReason === "pause_turn") log("run.pause_limit", { ...ids(ctx), pauses: snap.pauseCount });

  if (!ctx.sent.answered) await deliverAnswer(ctx, end, blocks);
  await deliverCards(ctx, blocks);
  await deliverBakeryNotice(ctx);
  if (!(await finishRun(deps.db, run.id, deps.owner, "done"))) throw new LeaseLost();
  log("run.done", { ...ids(ctx), end, steps: ctx.steps, answer_ids: ctx.sent.answerIds, cards: ctx.sent.cards });
}

// The notice says "I answered without its data", so it only follows an answer.
async function deliverBakeryNotice(ctx: Ctx): Promise<void> {
  const { run, deps } = ctx;
  if (!ctx.snap?.bakeryDropped || ctx.sent.bakeryNoticeSent || ctx.sent.answerIds.length === 0) return;
  await sendText(deps.tg, run.chatId, t(ctx.lang, "bakeryUnavailableNotice"), {
    replyTo: ctx.sent.answerIds[0],
    threadId: run.threadId,
  });
  ctx.sent = { ...ctx.sent, bakeryNoticeSent: true };
  await checkpoint(ctx, { sent: ctx.sent });
}

async function deliverAnswer(ctx: Ctx, end: End, blocks: BetaContentBlock[]): Promise<void> {
  const { run, deps, lang } = ctx;
  const answer = answerText(blocks);
  let text = answer;
  let sources = answerSources(blocks);
  if (end === "refusal") {
    // A chime nobody asked for stays quiet rather than announce a refusal.
    text = ctx.chime ? "" : t(lang, "refusal");
    sources = [];
  } else if (end === "cut" && (answer || !ctx.chime)) {
    text = [answer, t(lang, "cutShort")].filter(Boolean).join("\n\n");
  }
  if (!text && !ctx.chime) {
    // Someone asked and is waiting: an empty answer (only thinking, or only tool calls) gets a notice.
    log("run.empty_answer", { ...ids(ctx), end });
    text = t(lang, "noAnswer");
  }
  if (!text) {
    log("run.silent", { ...ids(ctx), end, chime: ctx.chime });
    ctx.sent = { ...ctx.sent, answered: true };
    await checkpoint(ctx, { sent: ctx.sent });
    return;
  }
  // Parts delivered by an earlier attempt are skipped; each part is recorded the moment it
  // lands, so a crash or a failed later part never sends one twice.
  const from = ctx.sent.partsSent ?? 0;
  if (from > 0) log("run.answer_resumed", { ...ids(ctx), parts_sent: from });
  await sendAnswer(deps.tg, run.chatId, text, {
    replyTo: run.trigger.targetMessageId,
    threadId: run.threadId,
    tailMd2: sourcesBlock(t(lang, "sourcesLabel"), sources),
    from,
    onPartSent: (part) => onPartSent(ctx, part),
  });
  ctx.sent = { ...ctx.sent, answered: true };
  await checkpoint(ctx, { sent: ctx.sent });
  log("run.answered", { ...ids(ctx), end, message_ids: ctx.sent.answerIds, sources: sources.length });
}

// Recorded straight after the part's send; the part then becomes a bot row, so later runs see
// what the bot said. The part is already in the chat: a failed store is logged, not retried.
async function onPartSent(ctx: Ctx, part: SentPart): Promise<void> {
  const { run, deps } = ctx;
  ctx.sent = { ...ctx.sent, answerIds: [...ctx.sent.answerIds, ...part.ids], partsSent: part.index + 1 };
  const owned = await saveCheckpoint(deps.db, run.id, deps.owner, { sent: ctx.sent });
  // The first id is the part itself; a separate sources message, if any, comes after and isn't stored.
  const messageId = part.ids[0];
  if (messageId !== undefined) {
    try {
      const row = await insertMessage(deps.db, {
        chatId: run.chatId,
        messageId,
        threadId: run.threadId,
        fromId: null,
        fromName: ctx.botName,
        isBot: true,
        date: deps.now(),
        text: part.text,
        entities: null,
        replyToId: part.index === 0 ? run.trigger.targetMessageId : null,
        media: null,
        mediaGroupId: null,
      });
      if (row?.pruned.length) deps.deleteFiles(row.pruned);
    } catch (err) {
      log("run.store_answer_failed", { ...ids(ctx), message_id: messageId, error: errorText(err) });
    }
  }
  if (!owned) throw new LeaseLost();
}

async function deliverCards(ctx: Ctx, blocks: BetaContentBlock[]): Promise<void> {
  const { run, deps } = ctx;
  const proposals = extractProposals(blocks);
  if (proposals.length === 0) return;
  if (!deps.bakery) {
    log("run.cards_skipped_no_bakery", { ...ids(ctx), proposal_ids: proposals.map((p) => p.proposalId) });
    return;
  }
  await postCards(
    { tg: deps.tg, bakery: deps.bakery, lang: ctx.lang },
    {
      chatId: run.chatId,
      threadId: run.threadId,
      replyTo: ctx.sent.answerIds[0] ?? run.trigger.targetMessageId,
      proposals,
      already: ctx.sent.cards,
    },
    async (id) => {
      ctx.sent = { ...ctx.sent, cards: [...ctx.sent.cards, id] };
      await checkpoint(ctx, { sent: ctx.sent });
    },
  );
}

function httpStatus(err: unknown): number | null {
  if (err instanceof Anthropic.APIError) return err.status ?? null;
  if (err instanceof GrammyError) return err.error_code;
  return null;
}

// The attempt was counted at claim time; this only decides between failing now and releasing
// the run for a later retry (the runner then holds it back for attempts*30 s).
async function onError(ctx: Ctx, err: unknown): Promise<void> {
  const status = httpStatus(err);
  const attempts = ctx.run.attempts;
  log("run.error", { ...ids(ctx), status, attempts, error: errorText(err) });
  if (status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
    return fail(ctx, `http_${status}: ${errorText(err)}`);
  }
  if (attempts >= MAX_ATTEMPTS) return fail(ctx, `attempts_exhausted: ${errorText(err)}`);
  await releaseLease(ctx.deps.db, ctx.run.id, ctx.deps.owner);
  log("run.retry_later", { ...ids(ctx), attempts });
}

// Ends the run as failed. Cards for proposals already made and the bakery notice (after an
// answer) still go out (best effort), and
// whoever is waiting gets an apology, unless an answer already went out or nobody asked (chime).
async function fail(ctx: Ctx, reason: string): Promise<void> {
  const { run, deps } = ctx;
  if (ctx.snap) {
    try {
      await deliverCards(ctx, runBlocks(ctx.snap.messages, ctx.snap.startIndex));
    } catch (err) {
      if (err instanceof LeaseLost) throw err;
      log("run.cards_failed", { ...ids(ctx), error: errorText(err) });
    }
    try {
      await deliverBakeryNotice(ctx);
    } catch (err) {
      if (err instanceof LeaseLost) throw err;
      log("run.bakery_notice_failed", { ...ids(ctx), error: errorText(err) });
    }
  }
  if (!(await finishRun(deps.db, run.id, deps.owner, "failed", reason))) throw new LeaseLost();
  log("run.failed", { ...ids(ctx), reason, chime: ctx.chime, answered: ctx.sent.answered });
  if (ctx.chime || ctx.sent.answered) return;
  try {
    await sendText(deps.tg, run.chatId, t(ctx.lang, "runFailed"), {
      replyTo: run.trigger.targetMessageId,
      threadId: run.threadId,
    });
  } catch (err) {
    log("run.failed_notice_failed", { ...ids(ctx), error: errorText(err) });
  }
}
