import { eq, lt } from "drizzle-orm";
import { processedUpdates } from "../schema";
import type { Db } from "../types";

/** True the first time an update id is seen, false for any repeat. */
export async function markUpdate(db: Db, updateId: number): Promise<boolean> {
  const rows = await db
    .insert(processedUpdates)
    .values({ updateId })
    .onConflictDoNothing()
    .returning({ id: processedUpdates.updateId });
  return rows.length > 0;
}

export async function unmarkUpdate(db: Db, updateId: number): Promise<void> {
  await db.delete(processedUpdates).where(eq(processedUpdates.updateId, updateId));
}

export async function pruneUpdates(db: Db, olderThan: Date): Promise<void> {
  await db.delete(processedUpdates).where(lt(processedUpdates.at, olderThan));
}
