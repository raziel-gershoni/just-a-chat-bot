import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPatch,
  bootstrap,
  createSaveQueue,
  forgetHistory,
  saveSettings,
  type ApiResult,
  type SaveStatus,
  type SettingsPatch,
} from "@/app/settings/client";
import type { SettingsView } from "@/src/miniapp/service";
import { settingsView } from "@/tests/helpers/settings-view";

type Call = { url: string; init: RequestInit };

// A fetch that answers each call with the next canned response (or throws it, for network errors).
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (status: number, body: unknown) => Response.json(body, { status });

function quietConsole() {
  return { error: vi.spyOn(console, "error").mockImplementation(() => {}), warn: vi.spyOn(console, "warn").mockImplementation(() => {}) };
}
afterEach(() => vi.restoreAllMocks());

describe("bootstrap", () => {
  it("posts initData in the JSON body, then reads the settings with the bearer token", async () => {
    const v = settingsView();
    const f = fakeFetch([json(200, { token: "jwt1", groupTitle: "Family", isOwner: false, lang: "en" }), json(200, v)]);
    const r = await bootstrap(f.fn, "query_id=1&hash=abc");
    expect(r).toEqual({ ok: true, data: { token: "jwt1", view: v } });
    expect(f.calls[0]!.url).toBe("/api/miniapp/session");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ initData: "query_id=1&hash=abc" });
    expect(f.calls[1]!.url).toBe("/api/miniapp/settings");
    expect(new Headers(f.calls[1]!.init.headers).get("authorization")).toBe("Bearer jwt1");
  });

  it("maps each session error to its code and stops", async () => {
    const c = quietConsole();
    for (const [status, error, expected] of [
      [404, "unknown_group", "unknown_group"],
      [403, "not_member", "not_member"],
      [401, "invalid", "invalid"],
      [400, "invalid", "failed"],
      [500, "internal", "failed"],
    ] as const) {
      const f = fakeFetch([json(status, { error })]);
      expect(await bootstrap(f.fn, "x"), `${status} ${error}`).toEqual({ ok: false, error: expected });
      expect(f.calls).toHaveLength(1);
    }
    expect(c.warn).toHaveBeenCalled();
  });

  it("without initData (opened outside Telegram) is invalid, logged, and sends nothing", async () => {
    const c = quietConsole();
    const f = fakeFetch([]);
    expect(await bootstrap(f.fn, "")).toEqual({ ok: false, error: "invalid" });
    expect(f.calls).toHaveLength(0);
    expect(c.warn).toHaveBeenCalled();
  });

  it("logs a network failure and reports it as failed", async () => {
    const c = quietConsole();
    const f = fakeFetch([new TypeError("Failed to fetch")]);
    expect(await bootstrap(f.fn, "x")).toEqual({ ok: false, error: "failed" });
    expect(c.error).toHaveBeenCalledWith(expect.stringContaining("/api/miniapp/session"), expect.any(TypeError));
  });

  it("logs a non-JSON reply and reports it as failed", async () => {
    const c = quietConsole();
    const f = fakeFetch([new Response("<html>bad gateway</html>", { status: 502 })]);
    expect(await bootstrap(f.fn, "x")).toEqual({ ok: false, error: "failed" });
    expect(c.error).toHaveBeenCalled();
  });

  it("reports an expired token on the settings read as invalid", async () => {
    quietConsole();
    const f = fakeFetch([json(200, { token: "jwt1" }), json(401, { error: "invalid" })]);
    expect(await bootstrap(f.fn, "x")).toEqual({ ok: false, error: "invalid" });
  });
});

describe("saveSettings / forgetHistory", () => {
  it("PUTs the patch as JSON with the bearer token and returns the new view", async () => {
    const v = settingsView();
    const f = fakeFetch([json(200, v)]);
    expect(await saveSettings(f.fn, "jwt1", { chime: { enabled: false } })).toEqual({ ok: true, data: v });
    const { url, init } = f.calls[0]!;
    expect(url).toBe("/api/miniapp/settings");
    expect(init.method).toBe("PUT");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer jwt1");
    expect(h.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ chime: { enabled: false } });
  });

  it("an expired session is invalid; a rejected patch is a plain failure", async () => {
    quietConsole();
    expect(await saveSettings(fakeFetch([json(401, { error: "invalid" })]).fn, "j", { historyWindow: 50 })).toEqual({ ok: false, error: "invalid" });
    expect(await saveSettings(fakeFetch([json(400, { error: "invalid" })]).fn, "j", { historyWindow: 50 })).toEqual({ ok: false, error: "failed" });
    expect(await saveSettings(fakeFetch([json(404, { error: "unknown_group" })]).fn, "j", { historyWindow: 50 })).toEqual({ ok: false, error: "unknown_group" });
  });

  it("forgetHistory POSTs with the bearer token", async () => {
    const f = fakeFetch([json(200, { ok: true })]);
    expect(await forgetHistory(f.fn, "jwt1")).toEqual({ ok: true, data: { ok: true } });
    expect(f.calls[0]!.url).toBe("/api/miniapp/forget");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe("Bearer jwt1");
  });
});

describe("applyPatch", () => {
  it("merges top-level fields and the nested chime object", () => {
    const v = settingsView();
    const next = applyPatch(v, { chime: { eagerness: "high" }, historyWindow: 400 });
    expect(next.settings.chime).toEqual({ enabled: true, eagerness: "high" });
    expect(next.settings.historyWindow).toBe(400);
    expect(next.settings.model).toBe(v.settings.model);
    expect(v.settings.chime.eagerness).toBe("low");
  });
});

describe("createSaveQueue", () => {
  type Pending = { patch: SettingsPatch; resolve: (r: ApiResult<SettingsView>) => void };
  function setup() {
    const initial = settingsView();
    const pending: Pending[] = [];
    const updates: { view: SettingsView; status: SaveStatus }[] = [];
    const queue = createSaveQueue({
      initial,
      put: (patch) => new Promise((resolve) => pending.push({ patch, resolve })),
      onUpdate: (view, status) => updates.push({ view, status }),
    });
    return { initial, pending, updates, queue };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("shows the change at once, sends one request at a time, and ends on the server's view", async () => {
    const { initial, pending, updates, queue } = setup();
    const a = queue.change("memory", { historyWindow: 200 });
    const b = queue.change("chime", { chime: { enabled: false } });
    expect(updates.at(-1)!.status).toEqual({ state: "saving", section: "chime" });
    expect(updates.at(-1)!.view.settings.historyWindow).toBe(200);
    expect(updates.at(-1)!.view.settings.chime.enabled).toBe(false);

    await tick();
    expect(pending).toHaveLength(1); // the second PUT waits for the first
    expect(pending[0]!.patch).toEqual({ historyWindow: 200 });

    const afterA = applyPatch(initial, { historyWindow: 200 });
    pending[0]!.resolve({ ok: true, data: afterA });
    await a;
    await tick();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.patch).toEqual({ chime: { enabled: false } });
    expect(updates.at(-1)!.status.state).toBe("saving");
    expect(updates.at(-1)!.view.settings.chime.enabled).toBe(false);

    const server = { ...applyPatch(afterA, { chime: { enabled: false } }), groupTitle: "Renamed" };
    pending[1]!.resolve({ ok: true, data: server });
    await b;
    expect(updates.at(-1)).toEqual({ view: server, status: { state: "saved", section: "chime" } });
  });

  it("a failure reverts that change and reports it on its section", async () => {
    const { initial, pending, updates, queue } = setup();
    const a = queue.change("memory", { historyWindow: 400 });
    await tick();
    pending[0]!.resolve({ ok: false, error: "failed" });
    await a;
    expect(updates.at(-1)).toEqual({ view: initial, status: { state: "error", section: "memory", error: "failed" } });
  });

  it("a failure followed by a success still reverts the failed change and keeps the error", async () => {
    const { initial, pending, updates, queue } = setup();
    const a = queue.change("memory", { historyWindow: 400 });
    const b = queue.change("language", { language: "he" });
    await tick();
    pending[0]!.resolve({ ok: false, error: "invalid" });
    await a;
    expect(updates.at(-1)!.view.settings.historyWindow).toBe(initial.settings.historyWindow);
    expect(updates.at(-1)!.view.settings.language).toBe("he");
    await tick();
    const server = applyPatch(initial, { language: "he" });
    pending[1]!.resolve({ ok: true, data: server });
    await b;
    expect(updates.at(-1)).toEqual({ view: server, status: { state: "error", section: "memory", error: "invalid" } });
  });

  it("a put that throws is logged, reverts, and later changes still go out", async () => {
    const c = quietConsole();
    const initial = settingsView();
    const updates: SaveStatus[] = [];
    let calls = 0;
    const queue = createSaveQueue({
      initial,
      put: async (patch) => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { ok: true, data: applyPatch(initial, patch) };
      },
      onUpdate: (_view, status) => updates.push(status),
    });
    await queue.change("memory", { historyWindow: 50 });
    expect(updates.at(-1)).toEqual({ state: "error", section: "memory", error: "failed" });
    expect(c.error).toHaveBeenCalled();
    await queue.change("memory", { historyWindow: 200 });
    expect(calls).toBe(2);
    expect(updates.at(-1)).toEqual({ state: "saved", section: "memory" });
  });
});
