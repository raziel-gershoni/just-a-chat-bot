import { describe, expect, it } from "vitest";
import { handleForget, handleGetSettings, handlePutSettings, handleSession } from "@/src/miniapp/routes";
import { signSession } from "@/src/miniapp/jwt";
import { upsertGroup } from "@/src/db/repo/groups";
import { testDb } from "@/tests/helpers/db";
import { fakeTg } from "@/tests/helpers/fake-tg";
import { fakeLlm } from "@/tests/helpers/fake-llm";
import { writeModelsCache } from "@/src/db/repo/models";

const SECRET = "s".repeat(40);
const NOW = new Date("2026-11-16T12:00:00Z");
async function setup() {
  const db = await testDb();
  await upsertGroup(db, { chatId: -100, title: "Fam", settings: {}, token: "tok_a" });
  await writeModelsCache(db, [{ id: "claude-opus-5-5", displayName: "O", maxTokens: 1, efforts: ["medium"], adaptive: true }], NOW);
  const deps = { db, tg: fakeTg(), llm: fakeLlm(), now: () => NOW, env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: 7, JWT_SECRET: SECRET } };
  const token = await signSession({ userId: 10, chatId: -100, owner: false, lang: "en" }, SECRET);
  return { deps, auth: { authorization: `Bearer ${token}` } };
}
const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request("http://x/api", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("miniapp routes", () => {
  it("401 without or with a bad bearer token", async () => {
    const { deps } = await setup();
    for (const h of [handleGetSettings, handlePutSettings, handleForget]) {
      expect((await h(req("GET"), deps)).status).toBe(401);
      expect((await h(req("GET", { authorization: "Bearer junk" }), deps)).status).toBe(401);
    }
  });
  it("session: 400 without initData, 401 with a bad one", async () => {
    const { deps } = await setup();
    expect((await handleSession(req("POST", {}, {}), deps)).status).toBe(400);
    const r = await handleSession(req("POST", {}, { initData: "garbage" }), deps);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "invalid" });
  });
  it("GET and PUT settings with a valid token; PUT bad body is 400", async () => {
    const { deps, auth } = await setup();
    const g = await handleGetSettings(req("GET", auth), deps);
    expect(g.status).toBe(200);
    expect((await g.json()).groupTitle).toBe("Fam");
    const p = await handlePutSettings(req("PUT", auth, { historyWindow: 200 }), deps);
    expect((await p.json()).settings.historyWindow).toBe(200);
    expect((await handlePutSettings(req("PUT", auth, { historyWindow: 7 }), deps)).status).toBe(400);
    expect((await handlePutSettings(new Request("http://x", { method: "PUT", headers: auth, body: "{" }), deps)).status).toBe(400);
  });
  it("forget answers ok", async () => {
    const { deps, auth } = await setup();
    const r = await handleForget(req("POST", auth), deps);
    expect(await r.json()).toEqual({ ok: true });
  });
});
