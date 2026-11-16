// Tells the owner once per deployed commit. The sha is compare-and-set in the meta table, so a
// restart of the same deploy, or two instances overlapping, send one message between them.
import { casMeta } from "../db/repo/meta";
import type { Db } from "../db/types";
import { t, type Lang } from "../i18n";
import type { TgApi } from "../telegram/types";

export async function deployPing(deps: {
  db: Db;
  tg: Pick<TgApi, "sendMessage">;
  ownerId: number;
  sha?: string;
  message?: string;
  /** The owner's language for this ops message (no per-owner setting exists; startup passes "en"). */
  lang?: Lang;
}): Promise<boolean> {
  if (!deps.sha) return false;
  if (!(await casMeta(deps.db, "deploy_sha", deps.sha))) return false;
  const lang = deps.lang ?? "en";
  const sha = deps.sha.slice(0, 7);
  const firstLine = (deps.message ?? "").split("\n")[0]!.trim();
  const text = firstLine ? t(lang, "deployPing", { sha, message: firstLine }) : t(lang, "deployPingNoMessage", { sha });
  await deps.tg.sendMessage(deps.ownerId, text);
  return true;
}
