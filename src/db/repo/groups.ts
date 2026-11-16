import { eq } from "drizzle-orm";
import { groups, messages, runs } from "../schema";
import type { Db } from "../types";

export type Group = typeof groups.$inferSelect;

export async function getGroup(db: Db, chatId: number): Promise<Group | null> {
  const [row] = await db.select().from(groups).where(eq(groups.chatId, chatId));
  return row ?? null;
}

export async function getGroupByToken(db: Db, token: string): Promise<Group | null> {
  const [row] = await db.select().from(groups).where(eq(groups.token, token));
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
 * A group became a supergroup: its chat id changes. Moves the group, messages and runs to
 * the new id. neon-http has no transactions, so every step is re-runnable: a crash midway is
 * finished by calling this again. A row already created for newId (the first message after
 * the migration) is discarded in favour of the old one.
 */
export async function migrateChat(db: Db, oldId: number, newId: number): Promise<void> {
  if (oldId === newId) return;
  const old = await getGroup(db, oldId);
  if (old) {
    await db.delete(messages).where(eq(messages.chatId, newId));
    await db.delete(runs).where(eq(runs.chatId, newId));
    await db.delete(groups).where(eq(groups.chatId, newId));
    await db.update(groups).set({ chatId: newId, updatedAt: new Date() }).where(eq(groups.chatId, oldId));
  }
  await db.update(messages).set({ chatId: newId }).where(eq(messages.chatId, oldId));
  await db.update(runs).set({ chatId: newId }).where(eq(runs.chatId, oldId));
}
