import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/src/config/env";
import * as schema from "./schema";
import type { Db } from "./types";

let cached: Db | null = null;

// Lazy so importing this module (build, tests) never needs DATABASE_URL.
export function db(): Db {
  if (!cached) {
    cached = drizzle(neon(env().DATABASE_URL), { schema });
  }
  return cached;
}
