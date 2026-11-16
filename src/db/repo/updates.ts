import { eq, lt } from "drizzle-orm";
import { processedUpdates } from "../schema";
import type { Db } from "../types";

/** True when the update was already handled successfully (the webhook's fast path). */
export async function isUpdateSeen(db: Db, updateId: number): Promise<boolean> {
  const rows = await db
    .select({ id: processedUpdates.updateId })
    .from(processedUpdates)
    .where(eq(processedUpdates.updateId, updateId));
  return rows.length > 0;
}

/** Records a handled update. True the first time an update id is marked, false for a repeat. */
export async function markUpdate(db: Db, updateId: number): Promise<boolean> {
  const rows = await db
    .insert(processedUpdates)
    .values({ updateId })
    .onConflictDoNothing()
    .returning({ id: processedUpdates.updateId });
  return rows.length > 0;
}

export async function pruneUpdates(db: Db, olderThan: Date): Promise<void> {
  await db.delete(processedUpdates).where(lt(processedUpdates.at, olderThan));
}
