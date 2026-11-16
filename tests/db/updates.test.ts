import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import { isUpdateSeen, markUpdate, pruneUpdates } from "@/src/db/repo/updates";

test("markUpdate is true once; isUpdateSeen follows it", async () => {
  const db = await testDb();
  expect(await isUpdateSeen(db, 5)).toBe(false);
  expect(await markUpdate(db, 5)).toBe(true);
  expect(await markUpdate(db, 5)).toBe(false);
  expect(await isUpdateSeen(db, 5)).toBe(true);
});

test("pruneUpdates removes old rows only", async () => {
  const db = await testDb();
  await markUpdate(db, 1);
  await pruneUpdates(db, new Date(Date.now() + 1000));
  expect(await markUpdate(db, 1)).toBe(true);
  await pruneUpdates(db, new Date(Date.now() - 100000));
  expect(await markUpdate(db, 1)).toBe(false);
});
