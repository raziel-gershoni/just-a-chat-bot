// Request handlers behind app/api/miniapp/*: Bearer-JWT parsing, JSON in/out, errors as {error}.
import { errorText } from "../util/errors";
import { log } from "../util/log";
import { claimsFromRequest, createSession } from "./auth";
import { forgetHistory, getSettingsView, updateSettings, type MiniDeps } from "./service";

const fail = (status: number, error: string) => Response.json({ error }, { status });

async function guarded(event: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    log(event, { error: errorText(err) });
    return fail(500, "internal");
  }
}

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() };
  } catch (err) {
    log("miniapp.bad_json", { error: errorText(err) });
    return { ok: false };
  }
}

export function handleSession(req: Request, deps: MiniDeps): Promise<Response> {
  return guarded("miniapp.session_failed", async () => {
    const j = await readJson(req);
    const initData = j.ok && typeof (j.body as { initData?: unknown } | null)?.initData === "string"
      ? (j.body as { initData: string }).initData
      : null;
    if (!initData) return fail(400, "invalid");
    const r = await createSession(deps, initData);
    return "error" in r ? fail(r.status, r.error) : Response.json(r);
  });
}

export function handleGetSettings(req: Request, deps: MiniDeps): Promise<Response> {
  return guarded("miniapp.get_settings_failed", async () => {
    const claims = await claimsFromRequest(req, deps.env.JWT_SECRET);
    if (!claims) return fail(401, "invalid");
    const view = await getSettingsView(deps, claims);
    return view ? Response.json(view) : fail(404, "unknown_group");
  });
}

export function handlePutSettings(req: Request, deps: MiniDeps): Promise<Response> {
  return guarded("miniapp.put_settings_failed", async () => {
    const claims = await claimsFromRequest(req, deps.env.JWT_SECRET);
    if (!claims) return fail(401, "invalid");
    const j = await readJson(req);
    if (!j.ok) return fail(400, "invalid");
    const r = await updateSettings(deps, claims, j.body);
    return r.ok ? Response.json(r.view) : fail(r.status, r.error);
  });
}

export function handleForget(req: Request, deps: MiniDeps): Promise<Response> {
  return guarded("miniapp.forget_failed", async () => {
    const claims = await claimsFromRequest(req, deps.env.JWT_SECRET);
    if (!claims) return fail(401, "invalid");
    await forgetHistory(deps, claims);
    return Response.json({ ok: true });
  });
}
