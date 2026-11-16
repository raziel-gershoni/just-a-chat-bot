import { sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { testDb } from "@/tests/helpers/db";
import { fakeLlm } from "@/tests/helpers/fake-llm";
import { getModels, toLite } from "@/src/models/catalog";

const info = (id: string, over: Record<string, any> = {}) =>
  ({
    id,
    display_name: id.toUpperCase(),
    lifecycle: "active",
    max_tokens: 64000,
    capabilities: {
      image_input: { supported: true },
      effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: false }, max: { supported: false }, xhigh: null },
      thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } },
    },
    ...over,
  }) as any;

const lite = (id: string) => ({ id, displayName: id.toUpperCase(), maxTokens: 64000, efforts: ["low", "medium"], adaptive: true, fallbacks: false });
const t0 = new Date("2026-11-16T10:00:00Z");

describe("toLite", () => {
  test("maps efforts, adaptive and max tokens", () => {
    expect(toLite(info("m1"))).toEqual(lite("m1"));
  });
  test("tolerates missing capabilities", () => {
    expect(toLite(info("m", { capabilities: null, max_tokens: null }))).toEqual({
      id: "m", displayName: "M", maxTokens: 32000, efforts: [], adaptive: false, fallbacks: false,
    });
  });
  test("fallbacks from allowed_fallback_models", () => {
    expect(toLite(info("m", { allowed_fallback_models: ["claude-opus-5-5"] })).fallbacks).toBe(true);
    expect(toLite(info("m", { allowed_fallback_models: [] })).fallbacks).toBe(false);
    expect(toLite(info("m", { allowed_fallback_models: null })).fallbacks).toBe(false);
  });
});

describe("getModels", () => {
  test("filters inactive and non-image models", async () => {
    const db = await testDb();
    const llm = fakeLlm([], {
      models: [
        info("good"),
        info("old", { lifecycle: "deprecated" }),
        info("noimg", { capabilities: { ...info("x").capabilities, image_input: { supported: false } } }),
      ],
    });
    const got = await getModels({ db, llm, now: () => t0 });
    expect(got.map((m) => m.id)).toEqual(["good"]);
  });

  test("uses the cache within 24h without calling listModels", async () => {
    const db = await testDb();
    const llm = fakeLlm([], { models: [info("a")] });
    const spy = vi.spyOn(llm, "listModels");
    await getModels({ db, llm, now: () => t0 });
    const again = await getModels({ db, llm, now: () => new Date(t0.getTime() + 23 * 3600_000) });
    expect(again.map((m) => m.id)).toEqual(["a"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("refetches after 24h", async () => {
    const db = await testDb();
    const llm = fakeLlm([], { models: [info("a")] });
    const spy = vi.spyOn(llm, "listModels");
    await getModels({ db, llm, now: () => t0 });
    await getModels({ db, llm, now: () => new Date(t0.getTime() + 25 * 3600_000) });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("on error returns the stale cache", async () => {
    const db = await testDb();
    await getModels({ db, llm: fakeLlm([], { models: [info("a")] }), now: () => t0 });
    const failing = fakeLlm([], { models: new Error("boom") });
    const got = await getModels({ db, llm: failing, now: () => new Date(t0.getTime() + 30 * 3600_000) });
    expect(got.map((m) => m.id)).toEqual(["a"]);
  });

  test("a failed cache write is logged and the fetched models are still returned", async () => {
    const db = await testDb();
    // Reads work, every write to the cache fails.
    await db.execute(sql`create function no_writes() returns trigger language plpgsql as $$ begin raise exception 'disk full'; end $$`);
    await db.execute(sql`create trigger no_writes before insert or update on models_cache for each row execute function no_writes()`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const got = await getModels({ db, llm: fakeLlm([], { models: [info("a")] }), now: () => t0 });
    expect(got.map((m) => m.id)).toEqual(["a"]);
    expect(log.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain("models.cache_write_failed");
    log.mockRestore();
  });

  test("on error with no cache returns the default model", async () => {
    const db = await testDb();
    const got = await getModels({ db, llm: fakeLlm([], { models: new Error("boom") }), now: () => t0 });
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe("claude-opus-5-5");
  });
});
