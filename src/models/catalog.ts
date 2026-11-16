import type { BetaModelInfo } from "@anthropic-ai/sdk/resources/beta/models";
import type { Llm } from "../agent/llm";
import { readModelsCache, writeModelsCache } from "../db/repo/models";
import type { Db } from "../db/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";

export type ModelInfoLite = { id: string; displayName: string; maxTokens: number; efforts: string[]; adaptive: boolean };

const CACHE_MS = 24 * 3600_000;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const DEFAULT_MODEL: ModelInfoLite = {
  id: "claude-opus-5-5",
  displayName: "Claude Opus 5.5",
  maxTokens: 32000,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  adaptive: true,
};

export function toLite(m: BetaModelInfo): ModelInfoLite {
  const effort = m.capabilities?.effort;
  const efforts = effort?.supported ? EFFORT_LEVELS.filter((l) => effort[l]?.supported) : [];
  return {
    id: m.id,
    displayName: m.display_name,
    maxTokens: m.max_tokens ?? 32000,
    efforts,
    adaptive: m.capabilities?.thinking?.types?.adaptive?.supported ?? false,
  };
}

function cached(raw: unknown): ModelInfoLite[] | null {
  return Array.isArray(raw) && raw.length > 0 ? (raw as ModelInfoLite[]) : null;
}

export async function getModels(deps: { db: Db; llm: Llm; now: () => Date }): Promise<ModelInfoLite[]> {
  const row = await readModelsCache(deps.db);
  const now = deps.now();
  const fresh = row && now.getTime() - row.fetchedAt.getTime() < CACHE_MS ? cached(row.models) : null;
  if (fresh) return fresh;
  try {
    const all = await deps.llm.listModels();
    const models = all.filter((m) => m.lifecycle === "active" && m.capabilities?.image_input?.supported).map(toLite);
    await writeModelsCache(deps.db, models, now);
    return models;
  } catch (err) {
    log("models.fetch_failed", { error: errorText(err), stale: row != null });
    return (row && cached(row.models)) ?? [DEFAULT_MODEL];
  }
}
