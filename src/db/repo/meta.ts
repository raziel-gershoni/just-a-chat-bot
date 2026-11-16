import { eq, sql } from "drizzle-orm";
import { meta } from "../schema";
import type { Db } from "../types";

export async function getMeta(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ value: meta.value }).from(meta).where(eq(meta.key, key));
  return row?.value ?? null;
}

/** Atomic compare-and-set: true only when the stored value was absent or different. */
export async function casMeta(db: Db, key: string, value: string): Promise<boolean> {
  const rows = await db
    .insert(meta)
    .values({ key, value })
    .onConflictDoUpdate({
      target: meta.key,
      set: { value },
      setWhere: sql`${meta.value} <> excluded.value`,
    })
    .returning({ key: meta.key });
  return rows.length > 0;
}
