// Tells the owner once per deployed commit. The sha is compare-and-set in the meta table, so a
// restart of the same deploy, or two instances overlapping, send one message between them.
import { casMeta } from "../db/repo/meta";
import type { Db } from "../db/types";
import type { TgApi } from "../telegram/types";

export async function deployPing(deps: {
  db: Db;
  tg: Pick<TgApi, "sendMessage">;
  ownerId: number;
  sha?: string;
  message?: string;
}): Promise<boolean> {
  if (!deps.sha) return false;
  if (!(await casMeta(deps.db, "deploy_sha", deps.sha))) return false;
  const firstLine = (deps.message ?? "").split("\n")[0]!.trim();
  await deps.tg.sendMessage(deps.ownerId, `just-a-chat-bot deployed ${deps.sha.slice(0, 7)}: ${firstLine}`);
  return true;
}
