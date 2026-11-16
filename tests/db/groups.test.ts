import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import type { Db } from "@/src/db/types";
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
import { eq } from "drizzle-orm";
import { getMessage, insertMessage, recentMessages } from "@/src/db/repo/messages";
import { createRun, claimNextRun, deleteChatRuns, finishRun, saveCheckpoint } from "@/src/db/repo/runs";
import { runs } from "@/src/db/schema";

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

const mentionOf = (id: number) =>
  ({ type: "mention", messageId: id, targetMessageId: id, requesterId: 1, requesterName: "u" }) as const;

test("migrateChat moves the group, its messages and all its runs (ids negated); idempotent", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  await insertMessage(db, msg(-1, 1));
  await insertMessage(db, msg(-1, 2, { replyToId: 1 }));
  const done = await createRun(db, { chatId: -1, threadId: null, trigger: mentionOf(1) });
  await finishRun(db, (await claimNextRun(db, -1, "o", 1000, new Date()))!.id, "o", "done");
  const open = await createRun(db, { chatId: -1, threadId: null, trigger: mentionOf(2) });
  await db.update(runs).set({ sent: { answerIds: [5], answered: false, cards: [] } }).where(eq(runs.id, open!.id));
  await migrateChat(db, -1, -1001);
  await migrateChat(db, -1, -1001);
  expect(await getGroup(db, -1)).toBeNull();
  expect((await getGroup(db, -1001))?.token).toBe("tok-1");
  // The supergroup numbers its own messages from 1, so moved basic-group ids are negated.
  const moved = await recentMessages(db, -1001, 10);
  expect(moved.map((m) => [m.messageId, m.replyToId])).toEqual([[-1, null], [-2, -1]]);
  expect(await recentMessages(db, -1, 10)).toEqual([]);
  // The unfinished run finishes in the new chat; its old-chat ids are negated too.
  const claimed = await claimNextRun(db, -1001, "o", 1000, new Date());
  expect([claimed?.id, claimed?.trigger.messageId, claimed?.trigger.targetMessageId, claimed?.sent.answerIds]).toEqual([
    open!.id, -2, -2, [-5],
  ]);
  // Finished runs move too (so "forget" in the new chat deletes them), ids negated.
  const [old] = await db.select().from(runs).where(eq(runs.id, done!.id));
  expect([old?.chatId, old?.trigger.messageId]).toEqual([-1001, -1]);
  await deleteChatRuns(db, -1001);
  expect((await db.select().from(runs)).map((r) => r.id)).toEqual([open!.id]); // only the unfinished one is kept
});

test("migrateChat takes the lease from a run in flight, so its old process stops and the run restarts in the new chat", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  await insertMessage(db, msg(-1, 1));
  await createRun(db, { chatId: -1, threadId: null, trigger: mentionOf(1) });
  const running = (await claimNextRun(db, -1, "old-process", 60_000, new Date()))!;
  await migrateChat(db, -1, -1001);
  // A late checkpoint from the old process can't write its un-negated ids back.
  expect(await saveCheckpoint(db, running.id, "old-process", { sent: { answerIds: [50], answered: false, cards: [] } })).toBe(false);
  // Nobody claims it while the old process may still be inside a Claude call: only after its lease ran out.
  expect(await claimNextRun(db, -1001, "new-process", 60_000, new Date())).toBeNull();
  const again = await claimNextRun(db, -1001, "new-process", 60_000, new Date(Date.now() + 61_000));
  expect([again?.id, again?.sent.answerIds]).toEqual([running.id, []]);
});

// Runs `hook` right before the nth db.delete(...).where(...) executes: an update from the new
// chat landing in the middle of the move.
function hookBeforeDelete(db: Db, nth: number, hook: () => Promise<unknown>): Db {
  let n = 0;
  return new Proxy(db as object, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== "delete") return typeof v === "function" ? v.bind(target) : v;
      return (table: unknown) => {
        const builder = (v as (t: unknown) => object).call(target, table);
        if (++n !== nth) return builder;
        return new Proxy(builder, {
          get(t2, p2, r2) {
            const w = Reflect.get(t2, p2, r2);
            if (p2 !== "where") return typeof w === "function" ? w.bind(t2) : w;
            return (...args: unknown[]) => {
              const q = (w as (...a: unknown[]) => PromiseLike<unknown>).apply(t2, args);
              return { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => hook().then(() => q).then(res, rej) };
            };
          },
        });
      };
    },
  }) as Db;
}

test("a row created for the new id after the move read it is not deleted blind: the move fails, and its redelivery keeps that token", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  const racing = hookBeforeDelete(db, 1, () => upsertGroup(db, { chatId: -1001, title: "late", settings: {}, token: "late" }));
  await expect(migrateChat(racing, -1, -1001)).rejects.toThrow();
  await migrateChat(db, -1, -1001); // Telegram redelivers migrate_to after the 500
  expect((await getGroup(db, -1001))?.token).toBe("tok-1");
  expect((await getGroupByToken(db, "late"))?.chatId).toBe(-1001);
});

test("a settings link posted for the new chat id before the move keeps working", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  // An update from the new supergroup was handled first: a fresh row with its own token
  // (its welcome's settings button carries that token).
  await upsertGroup(db, { chatId: -1001, title: "fresh", settings: {}, token: "fresh" });
  await migrateChat(db, -1, -1001);
  await migrateChat(db, -1, -1001);
  expect((await getGroupByToken(db, "fresh"))?.chatId).toBe(-1001);
  expect((await getGroupByToken(db, "tok-1"))?.chatId).toBe(-1001);
  expect((await getGroup(db, -1001))?.token).toBe("tok-1");
});

test("after migrateChat, new messages and runs reuse the old ids without clashing", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  await insertMessage(db, msg(-1, 3, { text: "old question" }));
  await createRun(db, { chatId: -1, threadId: null, trigger: mentionOf(3) });
  await migrateChat(db, -1, -1001);
  expect(await insertMessage(db, msg(-1001, 3, { text: "new question" }))).not.toBeNull();
  expect(await createRun(db, { chatId: -1001, threadId: null, trigger: mentionOf(3) })).not.toBeNull();
  expect((await getMessage(db, -1001, 3))?.text).toBe("new question");
  expect((await getMessage(db, -1001, -3))?.text).toBe("old question");
});

test("migrateChat replaces a fresh row that already exists for the new id", async () => {
  const db = await testDb();
  await seedGroup(db, -1);
  await insertMessage(db, msg(-1, 1));
  await upsertGroup(db, { chatId: -1001, title: "fresh", settings: {}, token: "fresh" });
  await insertMessage(db, msg(-1001, 7));
  await migrateChat(db, -1, -1001);
  expect((await getGroup(db, -1001))?.token).toBe("tok-1");
  expect((await recentMessages(db, -1001, 10)).map((m) => m.messageId)).toEqual([-1]);
});
