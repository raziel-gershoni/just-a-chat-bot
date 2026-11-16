import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import { casMeta, getMeta } from "@/src/db/repo/meta";
import { readModelsCache, writeModelsCache } from "@/src/db/repo/models";

test("casMeta is true only when the value changed", async () => {
  const db = await testDb();
  expect(await getMeta(db, "deploy_sha")).toBeNull();
  expect(await casMeta(db, "deploy_sha", "abc")).toBe(true);
  expect(await casMeta(db, "deploy_sha", "abc")).toBe(false);
  expect(await casMeta(db, "deploy_sha", "def")).toBe(true);
  expect(await getMeta(db, "deploy_sha")).toBe("def");
});

test("models cache round-trips and overwrites", async () => {
  const db = await testDb();
  expect(await readModelsCache(db)).toBeNull();
  const t1 = new Date("2026-11-16T10:00:00Z");
  await writeModelsCache(db, [{ id: "a" }], t1);
  await writeModelsCache(db, [{ id: "b" }], new Date("2026-11-16T11:00:00Z"));
  const c = await readModelsCache(db);
  expect(c?.models).toEqual([{ id: "b" }]);
  expect(c?.fetchedAt.toISOString()).toBe("2026-11-16T11:00:00.000Z");
});
