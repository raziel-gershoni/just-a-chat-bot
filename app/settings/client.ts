// Browser side of the settings Mini App: the calls to app/api/miniapp/* and the save queue.
// Nothing here throws: every failure is logged to the console and comes back as an ApiError.
import type { z } from "zod";
import type { SettingsView } from "@/src/miniapp/service";
import type { settingsPatchSchema } from "@/src/settings/schema";

export type ApiError = "invalid" | "unknown_group" | "not_member" | "failed";
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type SectionId = "model" | "effort" | "chime" | "trigger" | "language" | "memory" | "bakery";
export type SaveStatus =
  | { state: "saving" | "saved"; section: SectionId }
  | { state: "error"; section: SectionId; error: ApiError };

// 401 is an expired or bad session whatever the endpoint; the other codes the UI explains come by name.
function errorOf(status: number, body: unknown): ApiError {
  const code = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if (code === "unknown_group" || code === "not_member") return code;
  return status === 401 ? "invalid" : "failed";
}

async function request<T>(fetchFn: typeof fetch, path: string, init: RequestInit & { method: string }): Promise<ApiResult<T>> {
  const what = `[settings] ${init.method} ${path}`;
  let res: Response;
  try {
    res = await fetchFn(path, init);
  } catch (err) {
    console.error(`${what} failed`, err);
    return { ok: false, error: "failed" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    console.error(`${what} answered ${res.status} without JSON`, err);
    return { ok: false, error: "failed" };
  }
  if (res.ok) return { ok: true, data: body as T };
  console.warn(`${what} rejected: ${res.status} ${JSON.stringify(body)}`);
  return { ok: false, error: errorOf(res.status, body) };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** initData -> session token -> the settings view. */
export async function bootstrap(fetchFn: typeof fetch, initData: string): Promise<ApiResult<{ token: string; view: SettingsView }>> {
  if (!initData) {
    console.warn("[settings] no Telegram initData: the page was opened outside Telegram");
    return { ok: false, error: "invalid" };
  }
  const session = await request<{ token: string }>(fetchFn, "/api/miniapp/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData }),
  });
  if (!session.ok) return session;
  const { token } = session.data;
  const view = await request<SettingsView>(fetchFn, "/api/miniapp/settings", { method: "GET", headers: bearer(token) });
  return view.ok ? { ok: true, data: { token, view: view.data } } : view;
}

export function saveSettings(fetchFn: typeof fetch, token: string, patch: SettingsPatch): Promise<ApiResult<SettingsView>> {
  return request<SettingsView>(fetchFn, "/api/miniapp/settings", {
    method: "PUT",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function forgetHistory(fetchFn: typeof fetch, token: string): Promise<ApiResult<{ ok: true }>> {
  return request<{ ok: true }>(fetchFn, "/api/miniapp/forget", { method: "POST", headers: bearer(token) });
}

/** The view as it will be once the server accepts the patch (chime merges field by field, like the server). */
export function applyPatch(view: SettingsView, patch: SettingsPatch): SettingsView {
  return { ...view, settings: { ...view.settings, ...patch, chime: { ...view.settings.chime, ...patch.chime } } };
}

export type SaveQueue = { change(section: SectionId, patch: SettingsPatch): Promise<void> };

/**
 * Saves changes one PUT at a time, in order (the server merges each patch into the stored settings,
 * so parallel PUTs could overwrite each other). The shown view is the server's last answer with the
 * unsent patches on top, so a failed change snaps back while later ones stay. A failure is reported
 * once the queue drains, on the section it came from.
 */
export function createSaveQueue(opts: {
  initial: SettingsView;
  put: (patch: SettingsPatch) => Promise<ApiResult<SettingsView>>;
  onUpdate: (view: SettingsView, status: SaveStatus) => void;
}): SaveQueue {
  let confirmed = opts.initial;
  const pending: { section: SectionId; patch: SettingsPatch }[] = [];
  let failure: { section: SectionId; error: ApiError } | null = null;
  let tail: Promise<void> = Promise.resolve();
  const shown = () => pending.reduce((view, p) => applyPatch(view, p.patch), confirmed);

  async function send(patch: SettingsPatch): Promise<ApiResult<SettingsView>> {
    try {
      return await opts.put(patch);
    } catch (err) {
      console.error("[settings] save threw", err);
      return { ok: false, error: "failed" };
    }
  }

  async function step(patch: SettingsPatch): Promise<void> {
    const r = await send(patch);
    const done = pending.shift();
    if (!done) throw new Error("save queue out of step");
    if (r.ok) confirmed = r.data;
    else failure = { section: done.section, error: r.error };
    const last = pending.at(-1);
    if (last) {
      opts.onUpdate(shown(), { state: "saving", section: last.section });
    } else if (failure) {
      opts.onUpdate(confirmed, { state: "error", ...failure });
      failure = null;
    } else {
      opts.onUpdate(confirmed, { state: "saved", section: done.section });
    }
  }

  return {
    change(section, patch) {
      pending.push({ section, patch });
      opts.onUpdate(shown(), { state: "saving", section });
      // The catch keeps the chain alive: a rejected link would silently stop every later save.
      tail = tail.then(() => step(patch)).catch((err) => console.error("[settings] save queue step failed", err));
      return tail;
    },
  };
}
