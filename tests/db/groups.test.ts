import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import { msg, seedGroup } from "@/tests/helpers/db-fixtures";
import {
  getGroup,
  getGroupByToken,
  markAdminHintSent,
  migrateChat,
  setForgetBefore,
  setGroupActive,
  updateSettings,
  upsertGroup,
} from "@/src/db/repo/groups";
import { insertMessage, recentMessages } from "@/src/db/repo/messages";
import { createRun, claimNextRun } from "@/src/db/repo/runs";

test("upsert, lookups and setters", async () => {
  const db = await testDb();
  await upsertGroup(db, { chatId: -1, title: "A", settings: { x: 1 }, token: "t1" });
  await setGroupActive(db, -1, false);
  expect((await getGroup(db, -1))?.active).toBe(false);
  await upsertGroup(db, { chatId: -1, title: "B", settings: { x: 2 }, token: "t2" });
  const g = await getGroup(db, -1);
  expect([g?.active, g?.title, g?.token, g?.settings]).toEqual([true, "B", "t1", { x: 1 }]);
  expect((await getGroupByToken(db, "t1"))?.chatId).toBe(-1);
  expect(await getGroupByToken(db, "nope")).toBeNull();
  await updateSettings(db, -1, { y: 3 });
  await markAdminHintSent(db, -1);
  const at = new Date("2026-11-16T00:00:00Z");
  await setForgetBefore(db, -1, at);
  const g2 = await getGroup(db, -1);
  expect([g2?.settings, g2?.adminHintSent, g2?.forgetBefore?.getTime()]).toEqual([{ y: 3 }, true, at.getTime()]);
  expect(await getGroup(db, 999)).toBeNull();
});

test("migrateChat moves group, messages and runs; idempotent", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  await insertMessage(db, msg(-1, 1));
  await createRun(db, { chatId: -1, threadId: null, trigger: { type: "mention", messageId: 1, targetMessageId: 1, requesterId: 1, requesterName: "u" } });
  await migrateChat(db, -1, -1001);
  await migrateChat(db, -1, -1001);
  expect(await getGroup(db, -1)).toBeNull();
  expect((await getGroup(db, -1001))?.token).toBe("tok-1");
  expect((await recentMessages(db, -1001, 10)).length).toBe(1);
  expect(await recentMessages(db, -1, 10)).toEqual([]);
  expect((await claimNextRun(db, -1001, "o", 1000, new Date()))?.chatId).toBe(-1001);
});

test("migrateChat replaces a fresh row that already exists for the new id", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  await insertMessage(db, msg(-1, 1));
  await upsertGroup(db, { chatId: -1001, title: "fresh", settings: {}, token: "fresh" });
  await insertMessage(db, msg(-1001, 7));
  await migrateChat(db, -1, -1001);
  expect((await getGroup(db, -1001))?.token).toBe("tok-1");
  expect((await recentMessages(db, -1001, 10)).map((m) => m.messageId)).toEqual([1]);
});
