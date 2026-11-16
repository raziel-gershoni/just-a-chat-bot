import { and, eq, or } from "drizzle-orm";
import { groups, messages, runs } from "../schema";
import type { Db } from "../types";
import { moveChatMessages } from "./messages";
import { moveChatRuns } from "./runs";

export type Group = typeof groups.$inferSelect;

export async function getGroup(db: Db, chatId: number): Promise<Group | null> {
  const [row] = await db.select().from(groups).where(eq(groups.chatId, chatId));
  return row ?? null;
}

/** The group a settings link's token belongs to: its own token, or the one kept by migrateChat. */
export async function getGroupByToken(db: Db, token: string): Promise<Group | null> {
  const [row] = await db.select().from(groups).where(or(eq(groups.token, token), eq(groups.altToken, token)));
  return row ?? null;
}

/** Insert a group; if it exists, reactivate it and refresh the title (settings and token are kept). */
export async function upsertGroup(
  db: Db,
  g: { chatId: number; title: string; settings: Record<string, unknown>; token: string },
): Promise<Group> {
  const [row] = await db
    .insert(groups)
    .values(g)
    .onConflictDoUpdate({
      target: groups.chatId,
      set: { active: true, title: g.title, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export async function setGroupActive(db: Db, chatId: number, active: boolean): Promise<void> {
  await db.update(groups).set({ active, updatedAt: new Date() }).where(eq(groups.chatId, chatId));
}

export async function updateSettings(db: Db, chatId: number, settings: Record<string, unknown>): Promise<void> {
  await db.update(groups).set({ settings, updatedAt: new Date() }).where(eq(groups.chatId, chatId));
}

export async function setForgetBefore(db: Db, chatId: number, at: Date): Promise<void> {
  await db.update(groups).set({ forgetBefore: at, updatedAt: new Date() }).where(eq(groups.chatId, chatId));
}

export async function markAdminHintSent(db: Db, chatId: number): Promise<void> {
  await db.update(groups).set({ adminHintSent: true, updatedAt: new Date() }).where(eq(groups.chatId, chatId));
}

/**
 * A basic group became a supergroup (e.g. topics were switched on): its chat id changes. Moves
 * the group, its messages and its runs to the new id. The supergroup numbers its own messages
 * from 1, so moved message ids are negated and never clash with new ones; a reply to a negated
 * id is sent without the reply.
 *
 * A row already created for newId (an update from the new chat handled before this one) is
 * discarded in favour of the old one, keeping its token as altToken: the settings button its
 * welcome posted keeps working. Only the row read here is deleted: one created after that read
 * makes the rename fail on the primary key, the webhook answers 500, and Telegram's redelivery
 * runs this again and keeps that row's token too.
 *
 * neon-http has no transactions, so every step is re-runnable: a crash midway is finished by
 * calling this again (altToken is saved on the old row before the fresh row is deleted, and
 * each move takes the rows out of the old id in one statement, so nothing is negated twice).
 */
export async function migrateChat(
  db: Db,
  oldId: number,
  newId: number,
): Promise<{ movedGroup: boolean; replacedNewRow: boolean }> {
  if (oldId === newId) return { movedGroup: false, replacedNewRow: false };
  const old = await getGroup(db, oldId);
  let replacedNewRow = false;
  if (old) {
    const fresh = await getGroup(db, newId);
    if (fresh) await db.update(groups).set({ altToken: fresh.token }).where(eq(groups.chatId, oldId));
    await db.delete(messages).where(eq(messages.chatId, newId));
    await db.delete(runs).where(eq(runs.chatId, newId));
    if (fresh) {
      await db.delete(groups).where(and(eq(groups.chatId, newId), eq(groups.token, fresh.token)));
      replacedNewRow = true;
    }
    await db.update(groups).set({ chatId: newId, updatedAt: new Date() }).where(eq(groups.chatId, oldId));
  }
  await moveChatMessages(db, oldId, newId);
  await moveChatRuns(db, oldId, newId);
  return { movedGroup: old !== null, replacedNewRow };
}
