import { beforeEach, describe, expect, it } from "vitest";
import { forgetHistory, getSettingsView, updateSettings, type MiniDeps } from "@/src/miniapp/service";
import type { SessionClaims } from "@/src/miniapp/jwt";
import { getGroup, upsertGroup } from "@/src/db/repo/groups";
import { insertMessage, recentMessages, setAnthropicFileId } from "@/src/db/repo/messages";
import { createRun, claimNextRun, finishRun } from "@/src/db/repo/runs";
import { writeModelsCache } from "@/src/db/repo/models";
import { testDb } from "@/tests/helpers/db";
import { fakeTg } from "@/tests/helpers/fake-tg";
import { fakeLlm, type FakeLlm } from "@/tests/helpers/fake-llm";
import { msg } from "@/tests/helpers/db-fixtures";
import { REACTION_EMOJIS } from "@/src/settings/emojis";

const NOW = new Date("2026-11-16T12:00:00Z");
const member: SessionClaims = { userId: 10, chatId: -100, owner: false, lang: "en" };
const owner: SessionClaims = { userId: 7, chatId: -100, owner: true, lang: "en" };
const models = [
  { id: "claude-opus-5-5", displayName: "Opus", maxTokens: 32000, efforts: ["low", "medium", "high", "xhigh", "max"], adaptive: true },
  { id: "claude-haiku-5-5", displayName: "Haiku", maxTokens: 32000, efforts: ["low", "medium", "high"], adaptive: true },
];

let deps: MiniDeps;
let llm: FakeLlm;
beforeEach(async () => {
  const db = await testDb();
  await upsertGroup(db, { chatId: -100, title: "Fam", settings: {}, token: "tok_a" });
  await writeModelsCache(db, models, NOW);
  llm = fakeLlm();
  deps = {
    db, tg: fakeTg(), llm, now: () => NOW,
    env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_OWNER_ID: 7, JWT_SECRET: "s".repeat(40), BAKERY_URL: "https://b", BAKERY_MCP_KEY: "k" },
  };
});

describe("getSettingsView", () => {
  it("a non-owner view has no bakery setting", async () => {
    const v = (await getSettingsView(deps, member))!;
    expect(v.groupTitle).toBe("Fam");
    expect(v.isOwner).toBe(false);
    expect(v.settings).not.toHaveProperty("bakery");
    expect(v.models).toEqual(models);
    expect(v.emojis).toEqual(REACTION_EMOJIS);
    expect(v.bakeryConfigured).toBe(true);
  });
  it("the owner view includes bakery", async () => {
    const v = (await getSettingsView(deps, owner))!;
    expect(v.settings).toHaveProperty("bakery", false);
  });
  it("bakeryConfigured is false without env", async () => {
    deps.env = { ...deps.env, BAKERY_URL: undefined };
    expect((await getSettingsView(deps, owner))!.bakeryConfigured).toBe(false);
  });
});

describe("updateSettings", () => {
  it("a non-owner patch with bakery -> 403 and nothing saved", async () => {
    const r = await updateSettings(deps, member, { bakery: true, historyWindow: 200 });
    expect(r).toEqual({ ok: false, status: 403, error: "forbidden" });
    expect((await getGroup(deps.db, -100))!.settings).toEqual({});
  });
  it("the owner can save bakery", async () => {
    const r = await updateSettings(deps, owner, { bakery: true });
    expect(r.ok && r.view.settings.bakery).toBe(true);
    expect((await getGroup(deps.db, -100))!.settings).toMatchObject({ bakery: true });
  });
  it("merges a partial patch (chime nested) and keeps the rest", async () => {
    await updateSettings(deps, member, { chime: { eagerness: "high" } });
    const r = await updateSettings(deps, member, { triggerEmoji: "🔥", historyWindow: 200 });
    expect(r.ok && r.view.settings).toMatchObject({
      chime: { enabled: true, eagerness: "high" }, triggerEmoji: "🔥", historyWindow: 200,
    });
  });
  it("coerces an unsupported effort to medium", async () => {
    const r = await updateSettings(deps, member, { model: "claude-haiku-5-5", effort: "max" });
    expect(r.ok && r.view.settings).toMatchObject({ model: "claude-haiku-5-5", effort: "medium" });
  });
  it("re-coerces the stored effort when only the model changes", async () => {
    await updateSettings(deps, member, { effort: "max" });
    const r = await updateSettings(deps, member, { model: "claude-haiku-5-5" });
    expect(r.ok && r.view.settings.effort).toBe("medium");
  });
  it("falls back to the first effort when medium is unsupported", async () => {
    await writeModelsCache(deps.db, [{ ...models[1]!, efforts: ["high", "max"] }], NOW);
    const r = await updateSettings(deps, member, { model: "claude-haiku-5-5", effort: "low" });
    expect(r.ok && r.view.settings.effort).toBe("high");
  });
  it("rejects an unknown model with 400", async () => {
    expect(await updateSettings(deps, member, { model: "gpt" })).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects invalid values and unknown keys with 400", async () => {
    expect(await updateSettings(deps, member, { historyWindow: 7 })).toMatchObject({ ok: false, status: 400 });
    expect(await updateSettings(deps, member, { triggerEmoji: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(await updateSettings(deps, member, { surprise: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(await updateSettings(deps, member, "nope")).toMatchObject({ ok: false, status: 400 });
  });
  it("404 for a deactivated group", async () => {
    const { setGroupActive } = await import("@/src/db/repo/groups");
    await setGroupActive(deps.db, -100, false);
    expect(await updateSettings(deps, member, { historyWindow: 50 })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("forgetHistory", () => {
  it("deletes messages and files, keeps a running run, sets forgetBefore", async () => {
    await insertMessage(deps.db, msg(-100, 1));
    await insertMessage(deps.db, msg(-100, 2));
    await setAnthropicFileId(deps.db, -100, 2, "file_x");
    const trig = { type: "mention" as const, messageId: 2, targetMessageId: 2, requesterId: 1, requesterName: "a" };
    const done = (await createRun(deps.db, { chatId: -100, threadId: null, trigger: trig }))!;
    await claimNextRun(deps.db, -100, "o", 1000, NOW);
    await finishRun(deps.db, done.id, "o", "done");
    const running = (await createRun(deps.db, { chatId: -100, threadId: null, trigger: { ...trig, type: "reply" } }))!;
    await claimNextRun(deps.db, -100, "o", 120_000, NOW);

    await forgetHistory(deps, member);

    expect(await recentMessages(deps.db, -100, 10)).toEqual([]);
    expect(llm.deleted).toEqual(["file_x"]);
    expect((await getGroup(deps.db, -100))!.forgetBefore).toEqual(NOW);
    const { runs } = await import("@/src/db/schema");
    const rows = await deps.db.select().from(runs);
    expect(rows.map((r) => r.id)).toEqual([running.id]);
  });
  it("a failed file delete is logged and does not abort", async () => {
    await insertMessage(deps.db, msg(-100, 1));
    await setAnthropicFileId(deps.db, -100, 1, "file_x");
    llm.deleteFile = async () => { throw new Error("gone"); };
    await forgetHistory(deps, member);
    expect((await getGroup(deps.db, -100))!.forgetBefore).toEqual(NOW);
  });
});
