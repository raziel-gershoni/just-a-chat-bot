import { and, asc, desc, eq, gt, gte, lte, max, sql } from "drizzle-orm";
import { groups, messages } from "../schema";
import type { Db } from "../types";

export type StoredMessage = typeof messages.$inferSelect;
export type NewMessage = Omit<typeof messages.$inferInsert, "seq" | "anthropicFileId" | "reactionRunDone">;

/** Max messages kept per group (2 x the largest history window). */
export const RETENTION = 800;
/** The history window start only moves in steps of this many messages (keeps prompt caching stable). */
export const WINDOW_STEP = 20;

/**
 * Store a message with the next per-chat seq. Returns null for a duplicate (chatId, messageId)
 * without consuming a seq. Rows older than the retention limit are deleted and their uploaded
 * file ids returned in `pruned`.
 */
export async function insertMessage(
  db: Db,
  m: NewMessage,
): Promise<(StoredMessage & { pruned: string[] }) | null> {
  const [existing] = await db
    .select({ id: messages.messageId })
    .from(messages)
    .where(and(eq(messages.chatId, m.chatId), eq(messages.messageId, m.messageId)));
  if (existing) return null;

  const [alloc] = await db
    .update(groups)
    .set({ nextSeq: sql`${groups.nextSeq} + 1` })
    .where(eq(groups.chatId, m.chatId))
    .returning({ seq: sql<number>`${groups.nextSeq} - 1` });
  if (!alloc) throw new Error(`insertMessage: unknown group ${m.chatId}`);
  const seq = Number(alloc.seq);

  // A concurrent duplicate can still lose here; that only leaves a harmless gap in seq.
  const [row] = await db.insert(messages).values({ ...m, seq }).onConflictDoNothing().returning();
  if (!row) return null;

  const old = await db
    .delete(messages)
    .where(and(eq(messages.chatId, m.chatId), lte(messages.seq, seq - RETENTION)))
    .returning({ fileId: messages.anthropicFileId });
  const pruned = old.map((r) => r.fileId).filter((f): f is string => f !== null);
  return { ...row, pruned };
}

export async function updateMessageText(
  db: Db,
  chatId: number,
  messageId: number,
  text: string,
  entities: unknown[] | null,
): Promise<void> {
  await db
    .update(messages)
    .set({ text, entities })
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)));
}

export async function getMessage(db: Db, chatId: number, messageId: number): Promise<StoredMessage | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)));
  return row ?? null;
}

/** Ascending history for the prompt; the start seq is fixed for 20 messages at a time. */
export async function windowMessages(
  db: Db,
  p: { chatId: number; threadId: number | null; window: number; after: Date | null },
): Promise<StoredMessage[]> {
  const [top] = await db.select({ seq: max(messages.seq) }).from(messages).where(eq(messages.chatId, p.chatId));
  const newest = top?.seq ?? 0;
  if (newest === 0) return [];
  const startSeq = Math.max(1, Math.floor((newest - p.window) / WINDOW_STEP) * WINDOW_STEP + 1);
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, p.chatId),
        gte(messages.seq, startSeq),
        p.threadId != null ? eq(messages.threadId, p.threadId) : undefined,
        p.after ? gt(messages.date, p.after) : undefined,
      ),
    )
    .orderBy(asc(messages.seq));
}

/** The newest `limit` messages, ascending. */
export async function recentMessages(db: Db, chatId: number, limit: number): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

export async function lastBotMessageAt(db: Db, chatId: number): Promise<Date | null> {
  const [row] = await db
    .select({ date: max(messages.date) })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.isBot, true)));
  return row?.date ?? null;
}

export async function setAnthropicFileId(db: Db, chatId: number, messageId: number, fileId: string): Promise<void> {
  await db
    .update(messages)
    .set({ anthropicFileId: fileId })
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)));
}

/** True for exactly one caller per message: a reaction may start only one run. */
export async function claimReactionRun(db: Db, chatId: number, messageId: number): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ reactionRunDone: true })
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId), eq(messages.reactionRunDone, false)))
    .returning({ id: messages.messageId });
  return rows.length > 0;
}

/** Delete every stored message of a chat; returns the uploaded file ids to clean up. */
export async function deleteChatMessages(db: Db, chatId: number): Promise<string[]> {
  const rows = await db.delete(messages).where(eq(messages.chatId, chatId)).returning({ fileId: messages.anthropicFileId });
  return rows.map((r) => r.fileId).filter((f): f is string => f !== null);
}

