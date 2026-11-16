import { z } from "zod";

// Railway and .env files give "" for unset optional variables.
const optional = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  ANTHROPIC_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  BAKERY_URL: optional,
  BAKERY_MCP_KEY: optional,
  RAILWAY_PUBLIC_DOMAIN: optional,
  RAILWAY_GIT_COMMIT_SHA: optional,
  RAILWAY_GIT_COMMIT_MESSAGE: optional,
  RAILWAY_DEPLOYMENT_ID: optional,
});

export type Env = {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_OWNER_ID: number;
  ANTHROPIC_API_KEY: string;
  DATABASE_URL: string;
  JWT_SECRET: string;
  BAKERY_URL?: string;
  BAKERY_MCP_KEY?: string;
  PUBLIC_DOMAIN?: string;
  GIT_SHA?: string;
  GIT_MESSAGE?: string;
  DEPLOYMENT_ID?: string;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = schema.safeParse(source);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${problems}`);
  }
  const v = r.data;
  return {
    TELEGRAM_BOT_TOKEN: v.TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: v.TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_OWNER_ID: v.TELEGRAM_OWNER_ID,
    ANTHROPIC_API_KEY: v.ANTHROPIC_API_KEY,
    DATABASE_URL: v.DATABASE_URL,
    JWT_SECRET: v.JWT_SECRET,
    BAKERY_URL: v.BAKERY_URL,
    BAKERY_MCP_KEY: v.BAKERY_MCP_KEY,
    PUBLIC_DOMAIN: v.RAILWAY_PUBLIC_DOMAIN,
    GIT_SHA: v.RAILWAY_GIT_COMMIT_SHA,
    GIT_MESSAGE: v.RAILWAY_GIT_COMMIT_MESSAGE,
    DEPLOYMENT_ID: v.RAILWAY_DEPLOYMENT_ID,
  };
}

let cached: Env | undefined;
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
