import { and, asc, desc, eq, gt, gte, isNull, lte, max, sql } from "drizzle-orm";
import { groups, messages } from "../schema";
import type { Db } from "../types";

export type StoredMessage = typeof messages.$inferSelect;
export type NewMessage = Omit<typeof messages.$inferInsert, "seq" | "anthropicFileId">;

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
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ text, entities })
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)))
    .returning({ id: messages.messageId });
  return rows.length > 0;
}

export async function getMessage(db: Db, chatId: number, messageId: number): Promise<StoredMessage | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.messageId, messageId)));
  return row ?? null;
}

/** One thread's rows: a null thread is a non-forum chat (every row is null there) or a forum's General. */
const inThread = (threadId: number | null) =>
  threadId != null ? eq(messages.threadId, threadId) : isNull(messages.threadId);

/**
 * Ascending history for the prompt: the thread's last `window` rows, its start seq fixed for 20
 * messages at a time. The window is counted within the thread, so a quiet topic keeps its
 * history while other topics are busy.
 */
export async function windowMessages(
  db: Db,
  p: { chatId: number; threadId: number | null; window: number; after: Date | null },
): Promise<StoredMessage[]> {
  const scope = and(
    eq(messages.chatId, p.chatId),
    inThread(p.threadId),
    p.after ? gt(messages.date, p.after) : undefined,
  );
  // The seq of the thread's window-th newest row; with fewer rows the window starts at the top.
  const [nth] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(scope)
    .orderBy(desc(messages.seq))
    .offset(p.window - 1)
    .limit(1);
  const startSeq = nth ? Math.floor((nth.seq - 1) / WINDOW_STEP) * WINDOW_STEP + 1 : 1;
  return db
    .select()
    .from(messages)
    .where(and(scope, gte(messages.seq, startSeq)))
    .orderBy(asc(messages.seq));
}

/** The newest `limit` messages of the chat, or of one thread when given, ascending. */
export async function recentMessages(
  db: Db,
  chatId: number,
  limit: number,
  only?: { threadId: number | null },
): Promise<StoredMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), only ? inThread(only.threadId) : undefined))
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

/**
 * Move a chat's messages to a new chat id (a basic group became a supergroup), negating their
 * ids: the supergroup numbers its own messages from 1, so the old ids would clash with new ones.
 */
export async function moveChatMessages(db: Db, oldId: number, newId: number): Promise<void> {
  await db
    .update(messages)
    .set({ chatId: newId, messageId: sql`-${messages.messageId}`, replyToId: sql`-${messages.replyToId}` })
    .where(eq(messages.chatId, oldId));
}

/** Delete every stored message of a chat; returns the uploaded file ids to clean up. */
export async function deleteChatMessages(db: Db, chatId: number): Promise<string[]> {
  const rows = await db.delete(messages).where(eq(messages.chatId, chatId)).returning({ fileId: messages.anthropicFileId });
  return rows.map((r) => r.fileId).filter((f): f is string => f !== null);
}

