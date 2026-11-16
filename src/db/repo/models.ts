import { eq } from "drizzle-orm";
import { modelsCache } from "../schema";
import type { Db } from "../types";

export async function readModelsCache(db: Db): Promise<{ fetchedAt: Date; models: unknown } | null> {
  const [row] = await db.select().from(modelsCache).where(eq(modelsCache.id, 1));
  return row ? { fetchedAt: row.fetchedAt, models: row.models } : null;
}

export async function writeModelsCache(db: Db, models: unknown, at: Date): Promise<void> {
  await db
    .insert(modelsCache)
    .values({ id: 1, fetchedAt: at, models })
    .onConflictDoUpdate({ target: modelsCache.id, set: { fetchedAt: at, models } });
}
