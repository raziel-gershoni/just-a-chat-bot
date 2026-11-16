import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createRunner } from "@/src/agent/runner";
import { claimNextRun, createRun, finishRun, type RunRow } from "@/src/db/repo/runs";
import { markUpdate } from "@/src/db/repo/updates";
import { processedUpdates, runs } from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { startSweeper, sweep } from "@/src/server/sweeper";
import { testDb } from "../helpers/db";
import { fakeTg } from "../helpers/fake-tg";

const DAY = 86_400_000;
const LEASE = 120_000;
const T0 = new Date("2026-11-16T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const trig = { type: "mention", messageId: 1, targetMessageId: 1, requesterId: 10, requesterName: "u" } as const;
const mk = (db: Db, chatId: number) => createRun(db, { chatId, threadId: null, trigger: trig });

let logSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  logSpy.mockRestore();
});
const logged = (event: string) =>
  logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);

describe("sweep", () => {
  it("recovers a run left running by a crashed owner once its lease expires (Review Focus 1/2)", async () => {
    const db = await testDb();
    const run = await mk(db, 5);
    await claimNextRun(db, 5, "crashed", LEASE, T0);
    let clock = at(60_000);
    const seen: RunRow[] = [];
    const runner = createRunner({
      db,
      tg: fakeTg(),
      owner: "new",
      leaseMs: LEASE,
      renewMs: 30_000,
      typingMs: 4_000,
      now: () => clock,
      process: async (r) => {
        seen.push(r);
        await finishRun(db, r.id, "new", "done");
      },
    });

    await sweep({ db, runner, now: () => clock });
    await runner.drain();
    expect(seen).toEqual([]); // the crashed owner's lease is still live

    clock = at(LEASE + 1);
    await sweep({ db, runner, now: () => clock });
    await runner.drain();
    expect(seen.map((r) => [r.id, r.leaseOwner])).toEqual([[run.id, "new"]]);
    expect(logged("sweep.recover")).toEqual([expect.objectContaining({ chat_ids: [5] })]);
  });

  it("prunes finished runs older than 30 days and updates older than 2 days, keeping the rest", async () => {
    const db = await testDb();
    const now = new Date();
    const old = await mk(db, 1);
    const recent = await mk(db, 2);
    const pending = await mk(db, 3);
    for (const r of [old, recent]) {
      await claimNextRun(db, r.chatId, "x", LEASE, now);
      await finishRun(db, r.id, "x", "done");
    }
    await db.update(runs).set({ updatedAt: new Date(now.getTime() - 31 * DAY) }).where(eq(runs.id, old.id));
    await db.update(runs).set({ updatedAt: new Date(now.getTime() - 29 * DAY) }).where(eq(runs.id, recent.id));
    await db.update(runs).set({ updatedAt: new Date(now.getTime() - 90 * DAY) }).where(eq(runs.id, pending.id));
    await markUpdate(db, 1);
    await markUpdate(db, 2);
    await db.update(processedUpdates).set({ at: new Date(now.getTime() - 3 * DAY) }).where(eq(processedUpdates.updateId, 1));
    await db.update(processedUpdates).set({ at: new Date(now.getTime() - 1 * DAY) }).where(eq(processedUpdates.updateId, 2));

    await sweep({ db, runner: { enqueue: () => {} }, now: () => now });

    expect((await db.select({ id: runs.id }).from(runs)).map((r) => r.id).sort()).toEqual([recent.id, pending.id].sort());
    expect((await db.select().from(processedUpdates)).map((u) => u.updateId)).toEqual([2]);
  });
});

describe("startSweeper", () => {
  it("sweeps every interval until stopped, and logs a failed sweep", async () => {
    const db = await testDb();
    await mk(db, 7);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const enqueued: number[] = [];
    let tick: () => void = () => {};
    const runner = {
      enqueue: (chatId: number) => {
        enqueued.push(chatId);
        tick();
      },
    };
    const swept = () => new Promise<void>((resolve) => (tick = resolve));

    const stop = startSweeper({ db, runner, now: () => new Date() }, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(enqueued).toEqual([]);
    let next = swept();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(enqueued).toEqual([7]);
    next = swept();
    await vi.advanceTimersByTimeAsync(1_000);
    await next;
    expect(enqueued).toEqual([7, 7]);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await new Promise((res) => setTimeout(res, 50));
    expect(enqueued).toEqual([7, 7]);

    const broken = startSweeper({ db: {} as Db, runner, now: () => new Date() }, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 50 && logged("sweep.failed").length === 0; i++) await new Promise((res) => setTimeout(res, 5));
    broken();
    expect(logged("sweep.failed")).toHaveLength(1);
    expect(logged("sweep.failed")[0]).toHaveProperty("error");
  });
});
