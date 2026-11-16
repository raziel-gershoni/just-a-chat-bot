import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import {
  chatsWithPendingRuns,
  claimNextRun,
  createRun,
  deferRetry,
  deleteChatRuns,
  finishRun,
  hasActiveRun,
  hasUserRunSince,
  pruneRuns,
  releaseLease,
  releaseUnstarted,
  renewLease,
  saveCheckpoint,
} from "@/src/db/repo/runs";

// Each run gets its own trigger message: one user trigger has at most one run.
let nextMsg = 1;
const trig = () => ({ type: "mention", messageId: nextMsg, targetMessageId: nextMsg++, requesterId: 1, requesterName: "u" }) as const;
const mk = async (db: Awaited<ReturnType<typeof testDb>>, chatId = 1) => (await createRun(db, { chatId, threadId: null, trigger: trig() }))!;
const t0 = new Date("2026-11-16T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

test("createRun defaults", async () => {
  const db = await testDb();
  const r = await mk(db);
  expect([r.status, r.steps, r.attempts, r.sent]).toEqual(["queued", 0, 0, { answerIds: [], answered: false, cards: [] }]);
});

test("claims oldest, blocks others while leased, advances after done", async () => {
  const db = await testDb();
  const a = await mk(db);
  const b = await mk(db);
  const c1 = await claimNextRun(db, 1, "x", 1000, t0);
  expect(c1?.id).toBe(a.id);
  expect(c1?.status).toBe("running");
  expect(await claimNextRun(db, 1, "y", 1000, at(500))).toBeNull();
  expect(await finishRun(db, a.id, "x", "done")).toBe(true);
  expect((await claimNextRun(db, 1, "y", 1000, at(500)))?.id).toBe(b.id);
});

test("an expired lease can be taken over by another owner", async () => {
  const db = await testDb();
  const a = await mk(db);
  await claimNextRun(db, 1, "x", 1000, t0);
  const r = await claimNextRun(db, 1, "y", 1000, at(1000));
  expect(r?.id).toBe(a.id);
  expect(r?.leaseOwner).toBe("y");
  expect(await saveCheckpoint(db, a.id, "x", { steps: 2 })).toBe(false);
});

test("a queued head leased by someone else is never skipped", async () => {
  const db = await testDb();
  await mk(db);
  await mk(db);
  await claimNextRun(db, 1, "x", 1000, t0);
  expect(await claimNextRun(db, 1, "y", 1000, at(10))).toBeNull();
});

test("concurrent claims yield exactly one winner", async () => {
  const db = await testDb();
  await mk(db);
  const rs = await Promise.all(["a", "b", "c"].map((o) => claimNextRun(db, 1, o, 1000, t0)));
  expect(rs.filter(Boolean).length).toBe(1);
});

test("saveCheckpoint writes only for the lease owner", async () => {
  const db = await testDb();
  const a = await mk(db);
  await claimNextRun(db, 1, "x", 1000, t0);
  expect(await saveCheckpoint(db, a.id, "z", { steps: 5 })).toBe(false);
  expect(await saveCheckpoint(db, a.id, "x", { steps: 3, attempts: 1, sent: { answerIds: [9], answered: true, cards: [] } })).toBe(true);
  const r = await claimNextRun(db, 1, "x", 1000, at(2000));
  // The claim itself counts one more attempt.
  expect([r?.steps, r?.attempts, r?.sent.answerIds]).toEqual([3, 2, [9]]);
});

test("each claim counts an attempt; releaseUnstarted gives a never-started claim back", async () => {
  const db = await testDb();
  const a = await mk(db);
  expect((await claimNextRun(db, 1, "x", 1000, t0))!.attempts).toBe(1);
  expect((await claimNextRun(db, 1, "y", 1000, at(2000)))!.attempts).toBe(2);
  await releaseUnstarted(db, a.id, "x"); // not the owner: no change
  await releaseUnstarted(db, a.id, "y");
  const r = await claimNextRun(db, 1, "z", 1000, at(2000));
  expect(r!.attempts).toBe(2);
});

test("a run created twice for one user trigger exists once; chime runs are never deduped", async () => {
  const db = await testDb();
  const t = { type: "reaction", messageId: 500, targetMessageId: 500, requesterId: 1, requesterName: "u" } as const;
  expect(await createRun(db, { chatId: 1, threadId: null, trigger: t })).not.toBeNull();
  expect(await createRun(db, { chatId: 1, threadId: null, trigger: { ...t, requesterId: 2 } })).toBeNull();
  expect(await createRun(db, { chatId: 2, threadId: null, trigger: t })).not.toBeNull();
  const chime = { ...t, type: "chime", requesterId: null, requesterName: null } as const;
  expect(await createRun(db, { chatId: 1, threadId: null, trigger: chime })).not.toBeNull();
  expect(await createRun(db, { chatId: 1, threadId: null, trigger: chime })).not.toBeNull();
});

test("hasUserRunSince ignores chime runs and older runs", async () => {
  const db = await testDb();
  const since = new Date(Date.now() - 60_000);
  const chime = { type: "chime", messageId: 1, targetMessageId: 1, requesterId: null, requesterName: null } as const;
  await createRun(db, { chatId: 1, threadId: null, trigger: chime });
  expect(await hasUserRunSince(db, 1, since)).toBe(false);
  await mk(db);
  expect(await hasUserRunSince(db, 1, since)).toBe(true);
  expect(await hasUserRunSince(db, 1, new Date(Date.now() + 60_000))).toBe(false);
});

test("renewLease and releaseLease respect ownership", async () => {
  const db = await testDb();
  await mk(db);
  const a = await claimNextRun(db, 1, "x", 1000, t0);
  expect(await renewLease(db, a!.id, "y", 5000, at(500))).toBe(false);
  expect(await renewLease(db, a!.id, "x", 5000, at(500))).toBe(true);
  expect(await claimNextRun(db, 1, "y", 1000, at(3000))).toBeNull();
  await releaseLease(db, a!.id, "y");
  expect(await claimNextRun(db, 1, "y", 1000, at(3000))).toBeNull();
  await releaseLease(db, a!.id, "x");
  expect((await claimNextRun(db, 1, "y", 1000, at(3000)))?.id).toBe(a!.id);
});

test("chatsWithPendingRuns and hasActiveRun", async () => {
  const db = await testDb();
  await mk(db, 1);
  await mk(db, 2);
  await mk(db, 3);
  expect((await chatsWithPendingRuns(db, t0)).sort()).toEqual([1, 2, 3]);
  expect(await hasActiveRun(db, 1, t0)).toBe(true);
  await claimNextRun(db, 1, "x", 1000, t0);
  expect((await chatsWithPendingRuns(db, at(10))).sort()).toEqual([2, 3]);
  expect(await hasActiveRun(db, 1, at(10))).toBe(true);
  expect(await hasActiveRun(db, 1, at(2000))).toBe(false);
  expect((await chatsWithPendingRuns(db, at(2000))).sort()).toEqual([1, 2, 3]);
  expect(await hasActiveRun(db, 99, t0)).toBe(false);
});

test("prune and delete touch finished runs only", async () => {
  const db = await testDb();
  const a = await mk(db);
  const b = await mk(db);
  await claimNextRun(db, 1, "x", 1000, t0);
  await finishRun(db, a.id, "x", "failed", "boom");
  await pruneRuns(db, new Date(Date.now() + 10000));
  expect((await claimNextRun(db, 1, "y", 1000, t0))?.id).toBe(b.id);
  await deleteChatRuns(db, 1);
  expect((await claimNextRun(db, 1, "y", 1000, at(5000)))?.id).toBe(b.id);
});

test("deferRetry holds a released run back for attempts*step, and touches nothing else", async () => {
  const db = await testDb();
  const a = await mk(db);
  await claimNextRun(db, 1, "x", 1000, t0);
  expect(await deferRetry(db, a.id, t0, 30_000)).toBeNull(); // still leased by x
  await saveCheckpoint(db, a.id, "x", { attempts: 2 });
  await releaseLease(db, a.id, "x");
  expect(await deferRetry(db, a.id, t0, 30_000)).toEqual({ attempts: 2, delayMs: 60_000 });
  expect(await claimNextRun(db, 1, "y", 1000, at(59_999))).toBeNull();
  expect(await chatsWithPendingRuns(db, at(59_999))).toEqual([]);
  expect(await chatsWithPendingRuns(db, at(60_000))).toEqual([1]);
  expect((await claimNextRun(db, 1, "y", 1000, at(60_000)))?.id).toBe(a.id);
  await finishRun(db, a.id, "y", "done");
  expect(await deferRetry(db, a.id, at(70_000), 30_000)).toBeNull(); // finished
});
