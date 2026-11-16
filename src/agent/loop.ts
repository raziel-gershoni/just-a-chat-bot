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
import { insertMessage, windowMessages } from "../db/repo/messages";
import { finishRun, releaseLease, saveCheckpoint, type RunRow } from "../db/repo/runs";
import type { RunSent, RunSnapshot } from "../db/schema";
import type { Db } from "../db/types";
import { t, type Lang } from "../i18n";
import type { ModelInfoLite } from "../models/catalog";
import { parseSettings, type GroupSettings } from "../settings/schema";
import { messageParts, sendAnswer, sendText, sourcesBlock } from "../telegram/send";
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
  /** Shown as the sender of the bot's stored answer rows. */
  botName: string;
  /** Fire-and-forget; logs its own failures (the same hook the dispatcher uses for pruned rows). */
  deleteFiles(ids: string[]): void;
};

const MAX_PAUSES = 5;
const MAX_ATTEMPTS = 3;
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

async function buildSnapshot(ctx: Ctx, group: Group, settings: GroupSettings): Promise<RunSnapshot> {
  const { run, deps } = ctx;
  const trigger = run.trigger;
  const rows = await windowMessages(deps.db, {
    chatId: run.chatId,
    threadId: run.threadId,
    window: settings.historyWindow,
    after: group.forgetBefore,
  });
  const target = rows.find((r) => r.messageId === trigger.targetMessageId);
  const focus = [trigger.messageId, trigger.targetMessageId, target?.replyToId].filter((id): id is number => id != null);
  const attach = new Map<number, Attach>();
  const uploadDeps = {
    db: deps.db,
    tg: deps.tg,
    token: deps.token,
    fetch: deps.fetch,
    upload: (buf: Buffer, name: string, mime: string) => deps.llm.upload(buf, name, mime),
  };
  for (const row of pickAttachments(rows, focus)) {
    const fileId = await ensureUploaded(uploadDeps, row);
    if (fileId) attach.set(row.messageId, { type: row.media?.kind === "pdf" ? "document" : "image", fileId });
  }
  const transcript = buildTranscript(rows, { attach, noNewer: t(ctx.lang, "noNewerMessages") });
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
    rows: rows.length,
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
  // The notice says "I answered without its data", so it only follows an answer.
  if (snap.bakeryDropped && !ctx.sent.bakeryNoticeSent && ctx.sent.answerIds.length > 0) {
    await sendText(deps.tg, run.chatId, t(ctx.lang, "bakeryUnavailableNotice"), {
      replyTo: ctx.sent.answerIds[0],
      threadId: run.threadId,
    });
    ctx.sent = { ...ctx.sent, bakeryNoticeSent: true };
    await checkpoint(ctx, { sent: ctx.sent });
  }
  if (!(await finishRun(deps.db, run.id, deps.owner, "done"))) throw new LeaseLost();
  log("run.done", { ...ids(ctx), end, steps: ctx.steps, answer_ids: ctx.sent.answerIds, cards: ctx.sent.cards });
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
  if (!text) {
    log("run.silent", { ...ids(ctx), end, chime: ctx.chime });
    ctx.sent = { ...ctx.sent, answered: true };
    await checkpoint(ctx, { sent: ctx.sent });
    return;
  }
  const answerIds = await sendAnswer(deps.tg, run.chatId, text, {
    replyTo: run.trigger.targetMessageId,
    threadId: run.threadId,
    tailMd2: sourcesBlock(t(lang, "sourcesLabel"), sources),
  });
  // Recorded straight after the send, so a crash from here on never sends it again.
  ctx.sent = { ...ctx.sent, answered: true, answerIds };
  const owned = await saveCheckpoint(deps.db, run.id, deps.owner, { sent: ctx.sent });
  log("run.answered", { ...ids(ctx), end, message_ids: answerIds, sources: sources.length });
  await storeAnswer(ctx, text, answerIds);
  if (!owned) throw new LeaseLost();
}

// Each part the answer went out as becomes a bot row, so later runs see what the bot said.
// The answer is already in the chat: a failure here is logged, not retried.
async function storeAnswer(ctx: Ctx, text: string, messageIds: number[]): Promise<void> {
  const { run, deps } = ctx;
  // The same split sendAnswer makes; its ids come one per part, in order (a separate
  // sources message, if any, comes last and isn't stored).
  const parts = messageParts(text.toWellFormed());
  for (const [i, part] of parts.entries()) {
    const messageId = messageIds[i];
    if (messageId === undefined) break;
    try {
      const row = await insertMessage(deps.db, {
        chatId: run.chatId,
        messageId,
        threadId: run.threadId,
        fromId: null,
        fromName: deps.botName,
        isBot: true,
        date: deps.now(),
        text: part,
        entities: null,
        replyToId: i === 0 ? run.trigger.targetMessageId : null,
        media: null,
        mediaGroupId: null,
      });
      if (row?.pruned.length) deps.deleteFiles(row.pruned);
    } catch (err) {
      log("run.store_answer_failed", { ...ids(ctx), message_id: messageId, error: errorText(err) });
    }
  }
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

async function onError(ctx: Ctx, err: unknown): Promise<void> {
  const status = httpStatus(err);
  log("run.error", { ...ids(ctx), status, attempts: ctx.run.attempts, error: errorText(err) });
  if (status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
    return fail(ctx, `http_${status}: ${errorText(err)}`);
  }
  const attempts = ctx.run.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return fail(ctx, `attempts_exhausted: ${errorText(err)}`);
  await checkpoint(ctx, { attempts });
  await releaseLease(ctx.deps.db, ctx.run.id, ctx.deps.owner);
  log("run.retry_later", { ...ids(ctx), attempts });
}

// Ends the run as failed. Cards for proposals already made still go out (best effort), and
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
