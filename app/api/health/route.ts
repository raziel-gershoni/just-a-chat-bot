import { sql } from "drizzle-orm";
import { db } from "@/src/db/client";
import type { Db } from "@/src/db/types";
import { errorText } from "@/src/util/errors";
import { log } from "@/src/util/log";

export const dynamic = "force-dynamic";

export async function handleHealth(database: Db): Promise<Response> {
  try {
    await database.select({ one: sql`1` });
    return Response.json({ ok: true });
  } catch (err) {
    log("health_failed", { error: errorText(err) });
    return Response.json({ ok: false }, { status: 503 });
  }
}

export async function GET(): Promise<Response> {
  return handleHealth(db());
}
