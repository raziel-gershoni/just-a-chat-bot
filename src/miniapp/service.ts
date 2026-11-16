import type { Llm } from "../agent/llm";
import { bakeryConfig } from "../bakery/config";
import { getGroup, setForgetBefore, updateSettings as saveSettings, type Group } from "../db/repo/groups";
import { deleteChatMessages } from "../db/repo/messages";
import { deleteChatRuns } from "../db/repo/runs";
import type { Db } from "../db/types";
import { getModels, type ModelInfoLite } from "../models/catalog";
import { REACTION_EMOJIS } from "../settings/emojis";
import { parseSettings, settingsPatchSchema, type GroupSettings } from "../settings/schema";
import type { TgApi } from "../telegram/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";
import type { SessionClaims } from "./jwt";

export type MiniDeps = {
  db: Db;
  tg: Pick<TgApi, "getChatMember">;
  llm: Llm;
  now: () => Date;
  env: {
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_OWNER_ID: number;
    JWT_SECRET: string;
    BAKERY_URL?: string;
    BAKERY_MCP_KEY?: string;
  };
};

export type SettingsView = {
  groupTitle: string;
  settings: Omit<GroupSettings, "bakery"> & { bakery?: boolean };
  models: ModelInfoLite[];
  emojis: readonly string[];
  isOwner: boolean;
  bakeryConfigured: boolean;
};

export type ApiFailure = { ok: false; status: 400 | 403 | 404; error: string };
export type UpdateResult = { ok: true; view: SettingsView } | ApiFailure;

async function activeGroup(deps: MiniDeps, chatId: number): Promise<Group | null> {
  const g = await getGroup(deps.db, chatId);
  return g?.active ? g : null;
}

async function buildView(deps: MiniDeps, group: Group, claims: SessionClaims): Promise<SettingsView> {
  const { bakery, ...rest } = parseSettings(group.settings);
  return {
    groupTitle: group.title,
    settings: claims.owner ? { ...rest, bakery } : rest,
    models: await getModels(deps),
    emojis: REACTION_EMOJIS,
    isOwner: claims.owner,
    bakeryConfigured: bakeryConfig(deps.env) !== null,
  };
}

/** Null when the group is gone or deactivated since the session was issued. */
export async function getSettingsView(deps: MiniDeps, claims: SessionClaims): Promise<SettingsView | null> {
  const group = await activeGroup(deps, claims.chatId);
  return group ? buildView(deps, group, claims) : null;
}

// An effort the model doesn't support becomes the closest supported one: medium, else the first.
function supportedEffort(effort: GroupSettings["effort"], model: ModelInfoLite): GroupSettings["effort"] {
  if (model.efforts.length === 0 || model.efforts.includes(effort)) return effort;
  return (model.efforts.includes("medium") ? "medium" : model.efforts[0]) as GroupSettings["effort"];
}

export async function updateSettings(deps: MiniDeps, claims: SessionClaims, patch: unknown): Promise<UpdateResult> {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    log("miniapp.settings_invalid", { chat_id: claims.chatId, by: claims.userId, issue: parsed.error.issues[0]?.message });
    return { ok: false, status: 400, error: "invalid" };
  }
  const p = parsed.data;
  if ("bakery" in p && !claims.owner) {
    log("miniapp.settings_forbidden", { chat_id: claims.chatId, by: claims.userId });
    return { ok: false, status: 403, error: "forbidden" };
  }
  const group = await activeGroup(deps, claims.chatId);
  if (!group) return { ok: false, status: 404, error: "unknown_group" };

  const current = parseSettings(group.settings);
  const next: GroupSettings = { ...current, ...p, chime: { ...current.chime, ...p.chime } };

  const models = await getModels(deps);
  const model = models.find((m) => m.id === next.model);
  if (!model) {
    if (p.model !== undefined) {
      log("miniapp.settings_unknown_model", { chat_id: claims.chatId, by: claims.userId, model: p.model });
      return { ok: false, status: 400, error: "invalid" };
    }
    // The stored model fell out of the catalog; leave it for the user to change.
  } else {
    next.effort = supportedEffort(next.effort, model);
  }

  await saveSettings(deps.db, claims.chatId, next);
  log("settings.changed", { chat_id: claims.chatId, by: claims.userId, keys: Object.keys(p) });
  return { ok: true, view: await buildView(deps, { ...group, settings: next }, claims) };
}

/** Wipes the group's stored messages, uploaded files and finished runs; messages before now are never read again. */
export async function forgetHistory(deps: MiniDeps, claims: SessionClaims): Promise<void> {
  const fileIds = await deleteChatMessages(deps.db, claims.chatId);
  for (const id of fileIds) {
    // Best effort: a failed delete only leaves an orphan file on Anthropic's side.
    await deps.llm.deleteFile(id).catch((err) => log("miniapp.forget_delete_file_failed", { file_id: id, error: errorText(err) }));
  }
  await deleteChatRuns(deps.db, claims.chatId);
  await setForgetBefore(deps.db, claims.chatId, deps.now());
  log("settings.forget", { chat_id: claims.chatId, by: claims.userId });
}
