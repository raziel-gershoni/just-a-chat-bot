import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { installShutdown } from "@/src/server/shutdown";
import { startup } from "@/src/server/startup";
import { testDb } from "../helpers/db";
import { fakeTg } from "../helpers/fake-tg";

let logSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
});

const events = () => logSpy.mock.calls.map((c) => (JSON.parse(String(c[0])) as { event: string }).event);

async function setup(over: { domain?: string } = { domain: "bot.example.com" }) {
  const tg = fakeTg();
  const stopped: string[] = [];
  const runner = { enqueue: vi.fn(), stopAccepting: vi.fn(), drain: vi.fn(async () => {}), activeChats: () => [] };
  const stopSweeper = vi.fn();
  const deps = {
    db: await testDb(),
    tg,
    runner,
    env: { TELEGRAM_WEBHOOK_SECRET: "sec", TELEGRAM_OWNER_ID: 7, PUBLIC_DOMAIN: over.domain, GIT_SHA: "abc1234", GIT_MESSAGE: "feat: z" },
    stops: [() => stopped.push("chime")],
    startSweeper: vi.fn(() => stopSweeper),
    now: () => new Date("2026-11-16T10:00:00Z"),
  };
  return { tg, deps, runner, stopped, stopSweeper };
}

describe("startup", () => {
  it("registers the webhook with the secret and all six update types", async () => {
    const { tg, deps } = await setup();
    await startup(deps, { installShutdown: () => {} });
    const call = tg.calls.find((c) => c.method === "setWebhook")!;
    expect(call.args[0]).toBe("https://bot.example.com/api/telegram");
    expect(call.args[1]).toEqual({
      secret_token: "sec",
      allowed_updates: ["message", "edited_message", "callback_query", "message_reaction", "my_chat_member", "chat_member"],
    });
    expect(deps.startSweeper).toHaveBeenCalledOnce();
  });

  it("skips setWebhook with a log when there is no domain", async () => {
    const { tg, deps } = await setup({ domain: undefined });
    await startup(deps, { installShutdown: () => {} });
    expect(tg.calls.some((c) => c.method === "setWebhook")).toBe(false);
    expect(events()).toContain("startup.webhook_skipped");
    expect(tg.calls.some((c) => c.method === "sendMessage")).toBe(true);
  });

  it("still pings, sweeps and starts the sweeper when setWebhook fails", async () => {
    const { tg, deps } = await setup();
    (tg as unknown as { setWebhook: unknown }).setWebhook = async () => {
      throw new Error("boom");
    };
    await startup(deps, { installShutdown: () => {} });
    expect(events()).toContain("startup.webhook_failed");
    expect(tg.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
    expect(deps.startSweeper).toHaveBeenCalledOnce();
  });

  it("a failing deploy ping does not block the sweeper", async () => {
    const { tg, deps } = await setup();
    (tg as unknown as { sendMessage: unknown }).sendMessage = async () => {
      throw new Error("tg down");
    };
    await startup(deps, { installShutdown: () => {} });
    expect(events()).toContain("startup.deploy_ping_failed");
    expect(deps.startSweeper).toHaveBeenCalledOnce();
  });
});

describe("installShutdown", () => {
  function capture() {
    const order: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      order.push("exit");
    }) as never);
    const handlers: Record<string, () => void> = {};
    vi.spyOn(process, "once").mockImplementation(((sig: string, fn: () => void) => {
      handlers[sig] = fn;
      return process;
    }) as never);
    return { order, exit, handlers };
  }

  it("on SIGTERM stops accepting, stops timers, waits for webhooks, drains, then exits 0", async () => {
    const { runner, stopped } = await setup();
    const { order, exit, handlers } = capture();
    runner.stopAccepting.mockImplementation(() => order.push("stopAccepting"));
    runner.drain.mockImplementation(async () => {
      order.push("drain");
    });
    const webhooks = { count: () => 1, idle: async () => { order.push("webhooks_idle"); } };

    installShutdown(runner, [() => order.push("stopSweeper"), () => stopped.push("chime")], webhooks);
    expect(Object.keys(handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.SIGTERM!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["stopAccepting", "stopSweeper", "webhooks_idle", "drain", "exit"]);
    expect(stopped).toEqual(["chime"]);
    expect(events()).toContain("shutdown.done");
  });

  it("a throwing stop is logged and the other stops and the drain still run", async () => {
    const { runner } = await setup();
    const { order, exit, handlers } = capture();
    runner.stopAccepting.mockImplementation(() => { throw new Error("nope"); });
    runner.drain.mockImplementation(async () => {
      order.push("drain");
    });
    installShutdown(runner, [() => { throw new Error("timer boom"); }, () => order.push("chime")]);
    handlers.SIGTERM!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["chime", "drain", "exit"]);
    expect(events().filter((e) => e === "shutdown.step_failed")).toHaveLength(2);
  });
});
