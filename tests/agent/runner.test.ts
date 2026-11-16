import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createRunner, type Runner } from "@/src/agent/runner";
import {
  chatsWithPendingRuns,
  claimNextRun,
  createRun,
  finishRun,
  releaseLease,
  type RunRow,
} from "@/src/db/repo/runs";
import { runs } from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { testDb } from "../helpers/db";
import { fakeTg, type FakeTg } from "../helpers/fake-tg";

// claimNextRun passes through to the real query; one test wraps a single call to stage a race.
vi.mock("@/src/db/repo/runs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/src/db/repo/runs")>();
  return { ...mod, claimNextRun: vi.fn(mod.claimNextRun) };
});

const OWNER = "me";
const LEASE = 120_000;
let nextMsg = 1;
const trig = () => ({ type: "mention", messageId: nextMsg, targetMessageId: nextMsg++, requesterId: 10, requesterName: "u" }) as const;
const mk = async (db: Db, chatId: number, threadId: number | null = null) =>
  (await createRun(db, { chatId, threadId, trigger: trig() }))!;

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Real time passes so any loop that wrongly makes progress gets the chance to.
const settle = () => new Promise((r) => setTimeout(r, 50));

// A process() whose runs each wait for the test to release them, then finish as done.
function gated(db: Db) {
  const calls: RunRow[] = [];
  const gates = new Map<number, () => void>();
  const waiters: { n: number; resolve: () => void }[] = [];
  const process = async (run: RunRow) => {
    calls.push(run);
    const gate = deferred();
    gates.set(run.id, gate.resolve);
    for (const w of waiters) if (calls.length >= w.n) w.resolve();
    await gate.promise;
    await finishRun(db, run.id, OWNER, "done");
  };
  const started = (n: number) =>
    new Promise<void>((resolve) => (calls.length >= n ? resolve() : waiters.push({ n, resolve })));
  const release = (runId: number) => gates.get(runId)!();
  return { process, calls, started, release };
}

type Opts = Partial<Parameters<typeof createRunner>[0]>;
function runner(db: Db, tg: FakeTg, process: (run: RunRow, work: { startTyping(): void }) => Promise<void>, o: Opts = {}): Runner {
  return createRunner({
    db,
    tg,
    owner: OWNER,
    leaseMs: LEASE,
    renewMs: 30_000,
    typingMs: 4_000,
    now: () => new Date(),
    process,
    ...o,
  });
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });

describe("per-chat loop", () => {
  it("processes two runs of one chat in id order, the second only after the first resolves", async () => {
    const db = await testDb();
    const a = await mk(db, 1);
    const b = await mk(db, 1);
    const p = gated(db);
    const r = runner(db, fakeTg(), p.process);
    r.enqueue(1);
    await p.started(1);
    await settle();
    expect(p.calls.map((c) => c.id)).toEqual([a.id]);
    p.release(a.id);
    await p.started(2);
    expect(p.calls.map((c) => c.id)).toEqual([a.id, b.id]);
    p.release(b.id);
    await r.drain();
    expect(r.activeChats()).toEqual([]);
  });

  it("runs two chats concurrently", async () => {
    const db = await testDb();
    const a = await mk(db, 1);
    const b = await mk(db, 2);
    const p = gated(db);
    const r = runner(db, fakeTg(), p.process);
    r.enqueue(1);
    r.enqueue(2);
    await p.started(2);
    expect(p.calls.map((c) => c.chatId).sort()).toEqual([1, 2]);
    expect(r.activeChats().sort()).toEqual([1, 2]);
    p.release(a.id);
    p.release(b.id);
    await r.drain();
  });

  it("a second enqueue for a chat whose loop is running starts no second loop", async () => {
    const db = await testDb();
    const a = await mk(db, 1);
    const p = gated(db);
    const r = runner(db, fakeTg(), p.process);
    r.enqueue(1);
    r.enqueue(1);
    await p.started(1);
    r.enqueue(1);
    await settle();
    expect(r.activeChats()).toEqual([1]);
    let drained = false;
    const draining = r.drain().then(() => (drained = true));
    await settle();
    expect(drained).toBe(false);
    p.release(a.id);
    await draining;
    expect(p.calls.map((c) => c.id)).toEqual([a.id]);
  });

  it("a run created while the loop's last claim is in flight is still picked up", async () => {
    const db = await testDb();
    const a = await mk(db, 1);
    const seen: number[] = [];
    let r!: Runner;
    const process = async (run: RunRow) => {
      seen.push(run.id);
      await finishRun(db, run.id, OWNER, "done");
    };
    const real = (await vi.importActual<typeof import("@/src/db/repo/runs")>("@/src/db/repo/runs")).claimNextRun;
    let b: RunRow | null = null;
    vi.mocked(claimNextRun)
      .mockImplementationOnce(real)
      .mockImplementationOnce(async (...args) => {
        const got = await real(...args); // empty: b doesn't exist yet
        b = await mk(db, 1); // ...but is created and enqueued before the loop sees the answer
        r.enqueue(1);
        return got;
      });
    r = runner(db, fakeTg(), process);
    r.enqueue(1);
    await r.drain();
    expect(seen).toEqual([a.id, b!.id]);
  });

  it("after stopAccepting, enqueue starts nothing and drain waits for the in-flight process", async () => {
    const db = await testDb();
    const a = await mk(db, 1);
    await mk(db, 1);
    await mk(db, 2);
    const p = gated(db);
    const r = runner(db, fakeTg(), p.process);
    r.enqueue(1);
    await p.started(1);
    r.stopAccepting();
    r.enqueue(2);
    let drained = false;
    const draining = r.drain().then(() => (drained = true));
    await settle();
    expect(r.activeChats()).toEqual([1]);
    expect(drained).toBe(false);
    p.release(a.id);
    await draining;
    // The chat's next run is left for the next instance; chat 2 never started.
    expect(p.calls.map((c) => c.id)).toEqual([a.id]);
    expect(logged("runner.enqueue_ignored")).toEqual([expect.objectContaining({ chat_id: 2 })]);
  });

  it("a run claimed while shutdown begins is given back untouched, its attempt undone", async () => {
    const db = await testDb();
    const a = await mk(db, 1);
    const process = vi.fn(async () => {});
    let r!: Runner;
    const real = (await vi.importActual<typeof import("@/src/db/repo/runs")>("@/src/db/repo/runs")).claimNextRun;
    vi.mocked(claimNextRun).mockImplementationOnce(async (...args) => {
      const got = await real(...args);
      r.stopAccepting(); // SIGTERM lands while the claim is in flight
      return got;
    });
    r = runner(db, fakeTg(), process);
    r.enqueue(1);
    await r.drain();
    expect(process).not.toHaveBeenCalled();
    const [row] = await db.select().from(runs).where(eq(runs.id, a.id));
    expect([row!.leaseOwner, row!.leaseUntil, row!.attempts]).toEqual([null, null, 0]);
    expect(await chatsWithPendingRuns(db, new Date())).toEqual([1]);
    expect(logged("runner.released_on_stop")).toEqual([expect.objectContaining({ chat_id: 1, run_id: a.id })]);
  });

  it("logs a loop error, ends the loop and leaves the run for the sweeper", async () => {
    const db = await testDb();
    await mk(db, 1);
    const r = runner(db, fakeTg(), async () => {
      throw new Error("boom");
    });
    r.enqueue(1);
    await r.drain();
    expect(logged("runner.loop_error")).toHaveLength(1);
    expect(logged("runner.loop_error")[0]).toMatchObject({ chat_id: 1, error: "boom" });
    expect(r.activeChats()).toEqual([]);
  });
});

describe("typing and lease heartbeat", () => {
  it("once process starts it, sends typing in the run's thread every typingMs, and stops after", async () => {
    const db = await testDb();
    const run = await mk(db, 1, 7);
    fakeTimers();
    const tg = fakeTg();
    const started = deferred();
    const r = runner(db, tg, async (row, work) => {
      work.startTyping();
      work.startTyping(); // a second start changes nothing
      started.resolve();
      await new Promise((res) => setTimeout(res, 9_000));
      await finishRun(db, row.id, OWNER, "done");
    });
    r.enqueue(1);
    await started.promise;
    await vi.advanceTimersByTimeAsync(9_000);
    await r.drain();
    const typing = tg.calls.filter((c) => c.method === "sendChatAction");
    expect(typing.length).toBeGreaterThanOrEqual(2);
    for (const c of typing) expect(c.args).toEqual([run.chatId, "typing", { message_thread_id: 7 }]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tg.calls.filter((c) => c.method === "sendChatAction")).toHaveLength(typing.length);
  });

  it("shows no typing until process starts it (a chime, or a reply not yet judged)", async () => {
    const db = await testDb();
    const run = await mk(db, 1);
    const tg = fakeTg();
    const p = gated(db);
    const r = runner(db, tg, p.process);
    r.enqueue(1);
    await p.started(1);
    await settle();
    p.release(run.id);
    await r.drain();
    expect(tg.calls.filter((c) => c.method === "sendChatAction")).toHaveLength(0);
  });

  it("logs a failed typing action and still finishes the run", async () => {
    const db = await testDb();
    const run = await mk(db, 1);
    const tg = fakeTg();
    tg.sendChatAction = async () => {
      throw new Error("chat not found");
    };
    const r = runner(db, tg, async (row, work) => {
      work.startTyping();
      await finishRun(db, row.id, OWNER, "done");
    });
    r.enqueue(1);
    await r.drain();
    expect(logged("runner.typing_failed")[0]).toMatchObject({ chat_id: 1, run_id: run.id, error: "chat not found" });
  });

  it("renews the lease so a process longer than the lease keeps the chat", async () => {
    const db = await testDb();
    await mk(db, 1);
    fakeTimers();
    const started = deferred();
    const r = runner(
      db,
      fakeTg(),
      async (row) => {
        started.resolve();
        await new Promise((res) => setTimeout(res, 25_000));
        await finishRun(db, row.id, OWNER, "done");
      },
      { leaseMs: 10_000, renewMs: 3_000 },
    );
    r.enqueue(1);
    await started.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await claimNextRun(db, 1, "other", 10_000, new Date())).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    await r.drain();
  });

  it("logs when a renewal finds the lease taken", async () => {
    const db = await testDb();
    const run = await mk(db, 1);
    fakeTimers();
    const started = deferred();
    const r = runner(
      db,
      fakeTg(),
      async () => {
        started.resolve();
        await new Promise((res) => setTimeout(res, 10_000));
      },
      { renewMs: 3_000 },
    );
    r.enqueue(1);
    await started.promise;
    await db.update(runs).set({ leaseOwner: "thief" }).where(eq(runs.id, run.id));
    await vi.advanceTimersByTimeAsync(3_000);
    // The renewal's query settles on real time; poll for it without moving the fake clock.
    for (let i = 0; i < 200 && logged("runner.lease_renew_failed").length === 0; i++) {
      await new Promise((res) => setImmediate(res));
    }
    expect(logged("runner.lease_renew_failed")[0]).toMatchObject({ chat_id: 1, run_id: run.id });
    await vi.advanceTimersByTimeAsync(10_000);
    await r.drain();
  });
});

describe("retry after a released lease", () => {
  it("backs off attempts*30s before claiming the run again, and the sweeper waits too", async () => {
    const db = await testDb();
    const run = await mk(db, 1);
    fakeTimers();
    const seen: number[] = [];
    const second = deferred();
    const r = runner(db, fakeTg(), async (row) => {
      seen.push(row.id);
      if (seen.length === 1) {
        // What processRun does on a retryable error: release the lease (the claim counted the attempt).
        await releaseLease(db, row.id, OWNER);
        return;
      }
      await finishRun(db, row.id, OWNER, "done");
      second.resolve();
    });
    r.enqueue(1);
    await r.drain();
    expect(logged("runner.retry_scheduled")).toHaveLength(1);
    expect(logged("runner.retry_scheduled")[0]).toMatchObject({ chat_id: 1, run_id: run.id, attempts: 1, delay_ms: 30_000 });
    expect(await chatsWithPendingRuns(db, new Date(Date.now() + 10_000))).toEqual([]);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(seen).toEqual([run.id]);
    await vi.advanceTimersByTimeAsync(1_000);
    await second.promise;
    await r.drain();
    expect(seen).toEqual([run.id, run.id]);
  });
});
