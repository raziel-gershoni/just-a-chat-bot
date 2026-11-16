import { and, asc, eq, inArray, isNull, lt, lte, or, gt, sql } from "drizzle-orm";
import { runs, type RunSent, type RunSnapshot, type RunTrigger } from "../schema";
import type { Db } from "../types";

export type RunRow = typeof runs.$inferSelect;

const PENDING = ["queued", "running"] as const;

/**
 * Create a run. Null when this user trigger (chat, type, message) already has one: the unique
 * index makes run creation idempotent, so a redelivered update is safe to handle again.
 */
export async function createRun(
  db: Db,
  r: { chatId: number; threadId: number | null; trigger: RunTrigger },
): Promise<RunRow | null> {
  const [row] = await db.insert(runs).values(r).onConflictDoNothing().returning();
  return row ?? null;
}

/**
 * Lease the OLDEST pending run of the chat, only if its lease is free or expired. A head run
 * leased by someone else blocks the chat (later runs are never skipped to), so per-chat order
 * holds across two instances. The head pick and the lease check are one statement. Each claim
 * counts one attempt in the same statement, so a run that keeps killing its process still
 * runs out of attempts.
 */
export async function claimNextRun(
  db: Db,
  chatId: number,
  owner: string,
  leaseMs: number,
  now: Date,
): Promise<RunRow | null> {
  const head = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.chatId, chatId), inArray(runs.status, [...PENDING])))
    .orderBy(asc(runs.id))
    .limit(1);
  const [row] = await db
    .update(runs)
    .set({
      status: "running",
      leaseOwner: owner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${runs.attempts} + 1`,
      updatedAt: now,
    })
    .where(and(inArray(runs.id, head), or(isNull(runs.leaseUntil), lte(runs.leaseUntil, now))))
    .returning();
  return row ?? null;
}

export async function renewLease(db: Db, runId: number, owner: string, leaseMs: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
    .returning({ id: runs.id });
  return rows.length > 0;
}

/** Write progress, but only while we still own the lease (a taken-over run must not be overwritten). */
export async function saveCheckpoint(
  db: Db,
  runId: number,
  owner: string,
  patch: { snapshot?: RunSnapshot; steps?: number; sent?: RunSent; attempts?: number },
): Promise<boolean> {
  const set: Partial<typeof runs.$inferInsert> = { updatedAt: new Date() };
  if (patch.snapshot !== undefined) set.snapshot = patch.snapshot;
  if (patch.steps !== undefined) set.steps = patch.steps;
  if (patch.sent !== undefined) set.sent = patch.sent;
  if (patch.attempts !== undefined) set.attempts = patch.attempts;
  const rows = await db
    .update(runs)
    .set(set)
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
    .returning({ id: runs.id });
  return rows.length > 0;
}

export async function finishRun(
  db: Db,
  runId: number,
  owner: string,
  status: "done" | "failed",
  error?: string,
): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ status, error: error ?? null, leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
    .returning({ id: runs.id });
  return rows.length > 0;
}

export async function releaseLease(db: Db, runId: number, owner: string): Promise<void> {
  await db
    .update(runs)
    .set({ leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)));
}

/** Give back a run claimed but never started (shutdown began): the claim's attempt is undone. */
export async function releaseUnstarted(db: Db, runId: number, owner: string): Promise<void> {
  await db
    .update(runs)
    .set({ leaseOwner: null, leaseUntil: null, attempts: sql`greatest(${runs.attempts} - 1, 0)`, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)));
}

/**
 * A run released for a retry (pending, no owner) stays unclaimable for attempts*stepMs, so
 * neither a new trigger nor any instance's sweeper retries it before its backoff. Null when the
 * run is finished or someone holds its lease.
 */
export async function deferRetry(
  db: Db,
  runId: number,
  now: Date,
  stepMs: number,
): Promise<{ attempts: number; delayMs: number } | null> {
  const [row] = await db
    .update(runs)
    .set({
      leaseUntil: sql`${now.toISOString()}::timestamptz + ${runs.attempts} * ${stepMs}::int * interval '1 millisecond'`,
      updatedAt: now,
    })
    .where(and(eq(runs.id, runId), isNull(runs.leaseOwner), inArray(runs.status, [...PENDING])))
    .returning({ attempts: runs.attempts });
  return row ? { attempts: row.attempts, delayMs: row.attempts * stepMs } : null;
}

/** Chats whose head (oldest pending) run could be claimed right now. */
export async function chatsWithPendingRuns(db: Db, now: Date): Promise<number[]> {
  const pending = await db
    .select({ chatId: runs.chatId, leaseUntil: runs.leaseUntil })
    .from(runs)
    .where(inArray(runs.status, [...PENDING]))
    .orderBy(asc(runs.id));
  const heads = new Map<number, Date | null>();
  for (const r of pending) if (!heads.has(r.chatId)) heads.set(r.chatId, r.leaseUntil);
  return [...heads].filter(([, until]) => !until || until <= now).map(([chatId]) => chatId);
}

/** A run is queued, or running under a live lease. */
export async function hasActiveRun(db: Db, chatId: number, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.chatId, chatId),
        or(eq(runs.status, "queued"), and(eq(runs.status, "running"), gt(runs.leaseUntil, now))),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** A user-trigger (non-chime) run was created in the chat after `since`. */
export async function hasUserRunSince(db: Db, chatId: number, since: Date): Promise<boolean> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.chatId, chatId), gt(runs.createdAt, since), sql`${runs.trigger}->>'type' <> 'chime'`))
    .limit(1);
  return rows.length > 0;
}

const FINISHED = ["done", "failed"] as const;

export async function pruneRuns(db: Db, olderThan: Date): Promise<void> {
  await db.delete(runs).where(and(inArray(runs.status, [...FINISHED]), lt(runs.updatedAt, olderThan)));
}

/**
 * Move a chat's runs to a new chat id (a basic group became a supergroup): unfinished ones finish
 * there, and "forget" in the new chat reaches the finished ones. The old chat's message ids they
 * hold are negated, like the moved messages (moveChatMessages). A held lease is handed to a
 * placeholder owner: the process still working on the run can't checkpoint its old-chat ids over
 * the negated ones (it gets LeaseLost and stops; its sends to the old chat fail anyway), and
 * nobody claims the run until that lease runs out, so it is never worked twice at once. It then
 * resumes under the new id from its last checkpoint.
 */
export async function moveChatRuns(db: Db, oldId: number, newId: number): Promise<void> {
  await db
    .update(runs)
    .set({
      chatId: newId,
      trigger: sql`${runs.trigger} || jsonb_build_object(
        'messageId', -((${runs.trigger}->>'messageId')::bigint),
        'targetMessageId', -((${runs.trigger}->>'targetMessageId')::bigint))`,
      sent: sql`jsonb_set(${runs.sent}, '{answerIds}', coalesce(
        (select jsonb_agg(-(a.id::bigint) order by a.n)
           from jsonb_array_elements_text(${runs.sent}->'answerIds') with ordinality as a(id, n)),
        '[]'::jsonb))`,
      leaseOwner: sql`case when ${runs.leaseOwner} is null then null else 'chat-migrated' end`,
    })
    .where(eq(runs.chatId, oldId));
}

export async function deleteChatRuns(db: Db, chatId: number): Promise<void> {
  await db.delete(runs).where(and(eq(runs.chatId, chatId), inArray(runs.status, [...FINISHED])));
}
