// I1: a webhook update whose handling fails part-way is handled again on redelivery, and the
// end result is exactly one stored message and one run (Review Focus 1).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handleWebhook } from "@/app/api/telegram/route";
import { handleUpdate, type BotDeps } from "@/src/bot/dispatch";
import { createRun } from "@/src/db/repo/runs";
import { messages, runs } from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { testDb } from "../helpers/db";
import { fakeTg } from "../helpers/fake-tg";
import { BOT, OWNER_ID, groupMsg, msgUpdate, reactionUpdate, user } from "../helpers/fixtures";

vi.mock("@/src/db/repo/runs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/src/db/repo/runs")>();
  return { ...mod, createRun: vi.fn(mod.createRun) };
});

const SECRET = "s";
const post = (body: unknown) =>
  new Request("http://x/api/telegram", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(body),
  });

let db: Db;
let enqueue: ReturnType<typeof vi.fn<(chatId: number, delayMs?: number) => void>>;
let webhook: (body: unknown) => Promise<number>;
let logSpy: MockInstance;

beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  db = await testDb();
  const tg = fakeTg();
  tg.members.set(OWNER_ID, "member");
  enqueue = vi.fn<(chatId: number, delayMs?: number) => void>();
  const deps: BotDeps = {
    db, tg,
    env: { TELEGRAM_OWNER_ID: OWNER_ID },
    botId: BOT.id, botUsername: "MyBot",
    enqueue, chime: { onHumanMessage: vi.fn() }, onCallback: vi.fn(async () => {}),
    deleteFiles: vi.fn(), now: () => new Date(),
  };
  webhook = async (body) => (await handleWebhook(post(body), { secret: SECRET, db, handle: (u) => handleUpdate(u, deps) })).status;
});
afterEach(() => {
  logSpy.mockRestore();
  vi.mocked(createRun).mockClear();
});

const mention = (id: number) =>
  msgUpdate(groupMsg(-100, id, { text: "yo @MyBot", entities: [{ type: "mention", offset: 3, length: 6 }] }));

describe("webhook idempotency", () => {
  it("createRun failing after the message was stored: the redelivery creates exactly one run", async () => {
    const u = mention(1);
    vi.mocked(createRun).mockRejectedValueOnce(new Error("neon blip"));
    expect(await webhook(u)).toBe(500);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(runs)).toHaveLength(0);

    expect(await webhook(u)).toBe(200);
    const rows = await db.select().from(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toMatchObject({ type: "mention", messageId: 1 });
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("a duplicate delivery of a handled mention creates no second run, even without the seen mark", async () => {
    const u = mention(2);
    expect(await webhook(u)).toBe(200);
    expect(await webhook(u)).toBe(200);
    // The same update handled again past the fast path (e.g. the mark failed): still one run.
    await handleWebhook(post(u), { secret: SECRET, db, handle: async () => {} });
    expect(await db.select().from(runs)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("a reaction whose createRun failed is answered on redelivery, once", async () => {
    expect(await webhook(msgUpdate(groupMsg(-100, 3)))).toBe(200);
    const r = reactionUpdate(-100, 3, user(11), [], ["👾"]);
    vi.mocked(createRun).mockRejectedValueOnce(new Error("neon blip"));
    expect(await webhook(r)).toBe(500);
    expect(await webhook(r)).toBe(200);
    expect(await webhook(r)).toBe(200);
    const rows = await db.select().from(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toMatchObject({ type: "reaction", messageId: 3 });
  });
});
