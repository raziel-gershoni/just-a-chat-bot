import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createChimeScheduler } from "@/src/chime/scheduler";
import { setForgetBefore, updateSettings } from "@/src/db/repo/groups";
import { insertMessage } from "@/src/db/repo/messages";
import { createRun } from "@/src/db/repo/runs";
import type { RunTrigger } from "@/src/db/schema";
import { testDb } from "../helpers/db";
import { msg, seedGroup } from "../helpers/db-fixtures";
import { fakeLlm } from "../helpers/fake-llm";

const reply = (text: string): BetaMessage =>
  ({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text }] }) as unknown as BetaMessage;
const YES = reply('{"chime":true,"reason":"q"}');
const NO = reply('{"chime":false,"reason":"banter"}');

const NOW = new Date("2026-01-01T00:10:00Z");
let logSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());
const logged = (event: string) =>
  logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);

// Manual timers: only the latest pending callback per scheduler is live.
function timers() {
  const pending = new Map<number, () => unknown>();
  let id = 0;
  return {
    setTimeout: ((fn: () => unknown) => { pending.set(++id, fn); return id; }) as unknown as typeof setTimeout,
    clearTimeout: ((h: number) => { pending.delete(h); }) as unknown as typeof clearTimeout,
    pending,
    async fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const f of fns) await f();
    },
  };
}

async function setup(script: BetaMessage[] = [YES], opts: { bakery?: boolean } = {}) {
  const db = await testDb();
  await seedGroup(db, 1);
  const llm = fakeLlm([], { classify: script });
  const t = timers();
  const runs: Array<[number, RunTrigger]> = [];
  const s = createChimeScheduler({
    db,
    llm,
    now: () => NOW,
    enqueueRun: async (c, tr) => { runs.push([c, tr]); },
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
    bakeryConfigured: () => opts.bakery ?? false,
  });
  return { db, llm, t, runs, s };
}
// msg() dates are 2026-01-01T00:00:<id>s, i.e. ~10 min before NOW (older than the cooldown).
const add = (db: Awaited<ReturnType<typeof testDb>>, id: number, o = {}) => insertMessage(db, msg(1, id, o));

describe("createChimeScheduler", () => {
  it("debounces a burst into exactly one classify call", async () => {
    const { db, llm, t, s } = await setup();
    for (const id of [1, 2, 3]) {
      await add(db, id);
      s.onHumanMessage(1);
    }
    expect(t.pending.size).toBe(1);
    await t.fire();
    expect(llm.classifyCalls).toHaveLength(1);
  });

  it("uses the 30 s debounce by default", async () => {
    const db = await testDb();
    const spy = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const s = createChimeScheduler({ db, llm: fakeLlm(), now: () => NOW, enqueueRun: async () => {}, setTimeout: spy as any, clearTimeout: () => {} });
    s.onHumanMessage(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 30_000);
  });

  it("skips within the cooldown", async () => {
    const { db, llm, t, s, runs } = await setup();
    await add(db, 1);
    await add(db, 2, { isBot: true, fromId: 99, date: new Date(NOW.getTime() - 5 * 60_000) });
    await add(db, 3, { date: new Date(NOW.getTime() - 60_000) });
    s.onHumanMessage(1);
    await t.fire();
    expect(llm.classifyCalls).toHaveLength(0);
    expect(logged("chime.skip")[0]).toMatchObject({ reason: "cooldown" });
    expect(runs).toHaveLength(0);
  });

  it("skips when a run is active", async () => {
    const { db, llm, t, s } = await setup();
    await add(db, 1);
    await createRun(db, { chatId: 1, threadId: null, trigger: { type: "mention", messageId: 1, targetMessageId: 1, requesterId: 1, requesterName: "a" } });
    s.onHumanMessage(1);
    await t.fire();
    expect(llm.classifyCalls).toHaveLength(0);
    expect(logged("chime.skip")[0]).toMatchObject({ reason: "active_run" });
  });

  it("skips when the group is inactive, unknown or chime is off", async () => {
    const { db, llm, t, s } = await setup();
    await add(db, 1);
    await updateSettings(db, 1, { chime: { enabled: false } });
    s.onHumanMessage(1);
    await t.fire();
    s.onHumanMessage(404);
    await t.fire();
    expect(llm.classifyCalls).toHaveLength(0);
    expect(logged("chime.skip").map((l) => l.reason)).toEqual(["chime_off", "inactive"]);
  });

  it("skips when the latest message is from the bot", async () => {
    const { db, llm, t, s } = await setup();
    await add(db, 1);
    await add(db, 2, { isBot: true, fromId: 99, date: new Date(NOW.getTime() - 20 * 60_000) });
    s.onHumanMessage(1);
    await t.fire();
    expect(llm.classifyCalls).toHaveLength(0);
    expect(logged("chime.skip")[0]).toMatchObject({ reason: "last_is_bot" });
  });

  it("enqueues a chime run targeting the last message when the classifier says yes", async () => {
    const { db, t, s, runs } = await setup([YES]);
    await add(db, 1);
    await add(db, 2);
    s.onHumanMessage(1);
    await t.fire();
    expect(runs).toEqual([[1, { type: "chime", messageId: 2, targetMessageId: 2, requesterId: null, requesterName: null }]]);
    expect(logged("chime.decision")[0]).toMatchObject({ chime: true, reason: "q" });
  });

  it("does not enqueue when the classifier says no", async () => {
    const { db, t, s, runs } = await setup([NO]);
    await add(db, 1);
    s.onHumanMessage(1);
    await t.fire();
    expect(runs).toHaveLength(0);
    expect(logged("chime.decision")[0]).toMatchObject({ chime: false });
  });

  it("does not enqueue after two invalid classifier outputs", async () => {
    const { db, t, s, runs } = await setup([reply("x"), reply("y")]);
    await add(db, 1);
    s.onHumanMessage(1);
    await t.fire();
    expect(runs).toHaveLength(0);
    expect(logged("chime.skip")[0]).toMatchObject({ reason: "classifier_failed" });
  });

  it("only sends messages after forgetBefore, and bakery only when enabled and configured", async () => {
    const { db, llm, t, s } = await setup([NO, NO], { bakery: true });
    await add(db, 1, { text: "old secret" });
    await add(db, 2, { text: "new one" });
    await setForgetBefore(db, 1, new Date(Date.UTC(2026, 0, 1, 0, 0, 1, 500)));
    s.onHumanMessage(1);
    await t.fire();
    const body = JSON.stringify(llm.classifyCalls[0]!.messages);
    expect(body).toContain("new one");
    expect(body).not.toContain("old secret");
    expect(String(llm.classifyCalls[0]!.system)).not.toContain("bakery"); // settings.bakery is false
    await updateSettings(db, 1, { bakery: true });
    s.onHumanMessage(1);
    await t.fire();
    expect(String(llm.classifyCalls[1]!.system)).toContain("bakery");
  });

  it("logs and survives a failing enqueue; stop() clears timers", async () => {
    const db = await testDb();
    await seedGroup(db, 1);
    await add(db, 1);
    const t = timers();
    const s = createChimeScheduler({
      db, llm: fakeLlm([], { classify: [YES] }), now: () => NOW,
      enqueueRun: async () => { throw new Error("db down"); },
      setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
    });
    s.onHumanMessage(1);
    await t.fire();
    expect(logged("chime.error")[0]).toMatchObject({ chatId: 1 });
    s.onHumanMessage(1);
    s.stop();
    expect(t.pending.size).toBe(0);
  });
});
