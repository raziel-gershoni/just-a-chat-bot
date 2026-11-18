import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { eq, sql } from "drizzle-orm";
import { GrammyError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { processRun, type LoopDeps } from "@/src/agent/loop";
import { upsertGroup, setGroupActive } from "@/src/db/repo/groups";
import { getMessage, insertMessage, setAnthropicFileId } from "@/src/db/repo/messages";
import { claimNextRun, createRun, type RunRow } from "@/src/db/repo/runs";
import { groups, messages as messagesTable, runs, type RunTrigger } from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { t } from "@/src/i18n";
import { DEFAULT_MODEL } from "@/src/models/catalog";
import { defaultSettings } from "@/src/settings/schema";
import { testDb } from "../helpers/db";
import { msg } from "../helpers/db-fixtures";
import { fakeBakery } from "../helpers/fake-bakery";
import { fakeLlm, type FakeLlm } from "../helpers/fake-llm";
import { fakeTg, type FakeTg } from "../helpers/fake-tg";

const CHAT = -100;
const T0 = new Date("2026-11-16T10:00:00Z");
const LEASE = 120_000;
const later = (n = 1) => new Date(T0.getTime() + n * (LEASE + 1));
const CFG = { url: "https://b.example", key: "bmcp_testkey123" };

type Block = Record<string, unknown>;
const text = (s: string, citations: unknown[] | null = null): Block => ({ type: "text", text: s, citations });
const cite = (url: string, title: string) => ({ type: "web_search_result_location", url, title, cited_text: "", encrypted_index: "" });

function reply(content: Block[], stop_reason: string = "end_turn"): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    context_management: null,
    diagnostics: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

function apiError(status: number, message: string): Error {
  return Anthropic.APIError.generate(status, { type: "error", error: { type: "invalid_request_error", message } }, undefined, new Headers());
}

const propose: Block[] = [
  { type: "mcp_tool_use", id: "u1", name: "propose_bread_price", server_name: "bakery", input: { breadId: 1, price: 30 } },
  {
    type: "mcp_tool_result",
    tool_use_id: "u1",
    is_error: false,
    content: [{ type: "text", text: '{"proposalId":12,"status":"pending","summary":"הצעה","expiresAt":"x"}' }],
  },
  text("I proposed the new price; approve it on the card."),
];

let logSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});
const logged = (event: string) =>
  logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);

type Setup = {
  settings?: Record<string, unknown>;
  trigger?: Partial<RunTrigger>;
  threadId?: number | null;
};

async function setup(o: Setup = {}): Promise<{ db: Db; run: RunRow }> {
  const db = await testDb();
  await upsertGroup(db, { chatId: CHAT, title: "Family", settings: { ...defaultSettings("en"), ...o.settings }, token: "tok" });
  const threadId = o.threadId ?? null;
  await insertMessage(db, msg(CHAT, 4, { threadId, fromName: "Dana", text: "what time is it in Tokyo?" }));
  await insertMessage(db, msg(CHAT, 5, { threadId, fromName: "Avi", text: "@MyBot answer her" }));
  await createRun(db, {
    chatId: CHAT,
    threadId,
    trigger: { type: "mention", messageId: 5, targetMessageId: 5, requesterId: 10, requesterName: "Avi", ...o.trigger },
  });
  const run = await claimNextRun(db, CHAT, "A", LEASE, T0);
  return { db, run: run! };
}

function deps(db: Db, over: Partial<LoopDeps> & { llm: FakeLlm; tg?: FakeTg }): LoopDeps & { tg: FakeTg } {
  return {
    db,
    tg: fakeTg(),
    owner: "A",
    now: () => T0,
    bakeryCfg: null,
    bakery: null,
    token: "TOKEN",
    fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
    models: async () => [DEFAULT_MODEL],
    botIdentity: async () => ({ username: "Bot", firstName: "Bot" }),
    deleteFiles: vi.fn(),
    startTyping: vi.fn(),
    ...over,
  } as LoopDeps & { tg: FakeTg };
}

async function readRun(db: Db, id: number): Promise<RunRow> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row!;
}

// Another process takes the run over after this one died (lease expired).
async function reclaim(db: Db, owner: string, at = later()): Promise<RunRow> {
  const row = await claimNextRun(db, CHAT, owner, LEASE, at);
  expect(row).not.toBeNull();
  return row!;
}

const sends = (tg: FakeTg) => tg.calls.filter((c) => c.method === "sendMessage");
const sentText = (c: { args: unknown[] }) => c.args[1] as string;
const sentParams = (c: { args: unknown[] }) => c.args[2] as Record<string, any>;

describe("processRun", () => {
  it("end_turn: replies to the target in its thread, stores the bot row, finishes done", async () => {
    const { db, run } = await setup({ threadId: 7 });
    const llm = fakeLlm([reply([text("Hello")])]);
    const d = deps(db, { llm });
    await processRun(run, d);

    expect(llm.calls).toHaveLength(1);
    const msgs = llm.calls[0]!.messages as { role: string; content: unknown }[];
    expect(msgs.at(-1)!.role).toBe("system");
    expect(String(msgs.at(-1)!.content)).toContain('Group: "Family"');
    expect(JSON.stringify(msgs[0])).toContain("what time is it in Tokyo?");

    const s = sends(d.tg);
    expect(s).toHaveLength(1);
    expect(sentText(s[0]!)).toContain("Hello");
    expect(sentParams(s[0]!).reply_parameters.message_id).toBe(5);
    expect(sentParams(s[0]!).message_thread_id).toBe(7);

    const row = await getMessage(db, CHAT, 1000);
    expect(row).toMatchObject({ isBot: true, fromName: "Bot", text: "Hello", threadId: 7, replyToId: 5 });

    const after = await readRun(db, run.id);
    expect(after.status).toBe("done");
    expect(after.sent).toMatchObject({ answered: true, answerIds: [1000], cards: [] });
    expect(after.steps).toBe(1);
    expect(after.leaseOwner).toBeNull();
    expect(logged("run.step")[0]).toMatchObject({
      input_tokens: 100,
      cache_read_input_tokens: 80,
      output_tokens: 20,
      model: "claude-opus-5-5",
    });
  });

  it("hands the files of rows pruned by the stored answer to deleteFiles", async () => {
    const { db, run } = await setup();
    await setAnthropicFileId(db, CHAT, 4, "file_old");
    // The answer row lands 800+ rows after the seeded ones, so retention prunes them.
    await db.update(groups).set({ nextSeq: 1000 }).where(eq(groups.chatId, CHAT));
    const d = deps(db, { llm: fakeLlm([reply([text("Hello")])]) });
    await processRun(run, d);
    expect(d.deleteFiles).toHaveBeenCalledWith(["file_old"]);
    expect(await getMessage(db, CHAT, 4)).toBeNull();
  });

  it("attaches recent media as uploaded files", async () => {
    const { db, run } = await setup();
    await insertMessage(db, msg(CHAT, 6, { media: { kind: "photo", fileId: "tgphoto", label: "photo" }, text: "" }));
    const llm = fakeLlm([reply([text("Nice photo")])]);
    await processRun(run, deps(db, { llm }));
    expect(llm.uploads).toEqual([{ name: "6.jpg", mime: "image/jpeg" }]);
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain('{"type":"image","source":{"type":"file","file_id":"file_1"}');
  });

  it("pause_turn then end_turn: replays the first content unchanged with a byte-stable prefix", async () => {
    const { db, run } = await setup();
    const first = [text("Let me look"), { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "tokyo time" } }];
    const llm = fakeLlm([reply(first, "pause_turn"), reply([text("It is 19:00 there.")])]);
    const json: string[] = [];
    const stream = llm.stream.bind(llm);
    llm.stream = async (p) => { json.push(JSON.stringify(p)); return stream(p); };
    const d = deps(db, { llm });
    await processRun(run, d);

    expect(llm.calls).toHaveLength(2);
    const [p1, p2] = json.map((j) => JSON.parse(j) as { messages: unknown[] });
    expect(p2!.messages).toHaveLength(p1!.messages.length + 1);
    expect(p2!.messages.at(-1)).toEqual({ role: "assistant", content: first });
    // Everything but the appended message is byte-for-byte the first request.
    expect(JSON.stringify({ ...p2, messages: p2!.messages.slice(0, p1!.messages.length) })).toBe(json[0]);

    expect(sends(d.tg)).toHaveLength(1);
    expect(sentText(sends(d.tg)[0]!)).toContain("It is 19:00 there");
    const after = await readRun(db, run.id);
    expect(after.snapshot!.pauseCount).toBe(1);
    expect(after.steps).toBe(2);
  });

  it("stops after 5 pause_turn continuations (6 calls) and finalizes", async () => {
    const { db, run } = await setup();
    const pauses = Array.from({ length: 6 }, (_, i) => reply([text(`part${i + 1} `)], "pause_turn"));
    const llm = fakeLlm([...pauses, reply([text("never")])]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(llm.calls).toHaveLength(6);
    expect(sends(d.tg)).toHaveLength(1);
    expect(sentText(sends(d.tg)[0]!)).not.toContain("never");
    expect((await readRun(db, run.id)).status).toBe("done");
  });

  it("refusal: sends the localized refusal instead of any partial answer", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("Sure, here is how to")], "refusal")]);
    const d = deps(db, { llm });
    await processRun(run, d);
    const body = sentText(sends(d.tg)[0]!);
    expect(body).toContain("I can't help with that one");
    expect(body).not.toContain("here is how");
    expect((await readRun(db, run.id)).status).toBe("done");
  });

  it("max_tokens: sends the text with the cut-short note", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("A long answer that")], "max_tokens")]);
    const d = deps(db, { llm });
    await processRun(run, d);
    const body = sentText(sends(d.tg)[0]!);
    expect(body).toContain("A long answer that");
    expect(body).toContain("cut short");
    expect((await getMessage(db, CHAT, 1000))!.text).toBe(`A long answer that\n\n${t("en", "cutShort")}`);
  });

  it("chime with an empty answer sends nothing and finishes done", async () => {
    const { db, run } = await setup({ trigger: { type: "chime", requesterId: null, requesterName: null } });
    const llm = fakeLlm([reply([{ type: "thinking", thinking: "", signature: "sig" }])]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(sends(d.tg)).toHaveLength(0);
    const after = await readRun(db, run.id);
    expect(after.status).toBe("done");
    expect(after.sent).toMatchObject({ answered: true, answerIds: [] });
    expect(logged("run.silent")).toHaveLength(1);
  });

  it("web search citations: the answer ends with an expandable sources quote", async () => {
    const { db, run } = await setup();
    const content = [
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      text("It is 19:00.", [cite("https://time.example/tokyo", "Tokyo time")]),
    ];
    const llm = fakeLlm([reply(content)]);
    const d = deps(db, { llm });
    await processRun(run, d);
    const last = sentText(sends(d.tg).at(-1)!);
    expect(last).toContain("**>");
    expect(last).toContain("https://time.example/tokyo");
  });

  it("bakery proposal: posts a card replying to the answer; a restart sends nothing again", async () => {
    const { db, run } = await setup({ settings: { bakery: true } });
    const bakery = fakeBakery();
    bakery.proposals.set(12, "מחיר חדש ללחם: 30 ₪");
    const llm = fakeLlm([reply(propose)]);
    const d = deps(db, { llm, bakeryCfg: CFG, bakery });
    await processRun(run, d);

    expect((llm.calls[0] as { mcp_servers?: unknown[] }).mcp_servers).toHaveLength(1);
    const s = sends(d.tg);
    expect(s).toHaveLength(2);
    expect(sentText(s[0]!)).toContain("approve it on the card");
    expect(sentText(s[1]!)).toBe("מחיר חדש ללחם: 30 ₪");
    expect(sentParams(s[1]!).reply_parameters.message_id).toBe(1000);
    expect(sentParams(s[1]!).reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data))
      .toEqual(["mcp:approve:12", "mcp:reject:12"]);

    const done = await readRun(db, run.id);
    expect(done.status).toBe("done");
    expect(done.sent).toMatchObject({ answered: true, answerIds: [1000], cards: [12] });
    expect(JSON.stringify(done.snapshot)).not.toContain("bmcp_");

    // A crash just before finishRun: the run is left running with an expired lease.
    await db.update(runs).set({ status: "running", leaseOwner: "A", leaseUntil: T0 }).where(eq(runs.id, run.id));
    const llm2 = fakeLlm([]);
    const d2 = deps(db, { llm: llm2, owner: "B", bakeryCfg: CFG, bakery });
    await processRun(await reclaim(db, "B"), d2);
    expect(llm2.calls).toHaveLength(0);
    expect(sends(d2.tg)).toHaveLength(0);
    expect((await readRun(db, run.id)).status).toBe("done");
  });

  it("a crash after the step checkpoint and before the send: the next process sends once without calling Claude", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("Hello")])]);
    const tg = fakeTg();
    let reached!: () => void;
    const atSend = new Promise<void>((r) => { reached = r; });
    // The first process dies mid-send: the call never returns.
    tg.sendMessage = (() => { reached(); return new Promise(() => {}); }) as unknown as FakeTg["sendMessage"];
    void processRun(run, deps(db, { llm, tg }));
    await atSend;
    const stored = await readRun(db, run.id);
    expect(stored.snapshot!.stopReason).toBe("end_turn");
    expect(stored.sent.answered).toBe(false);

    const llm2 = fakeLlm([]);
    const d2 = deps(db, { llm: llm2, owner: "B" });
    await processRun(await reclaim(db, "B"), d2);
    expect(llm2.calls).toHaveLength(0);
    expect(sends(d2.tg)).toHaveLength(1);
    expect(sentText(sends(d2.tg)[0]!)).toContain("Hello");
    expect((await readRun(db, run.id)).status).toBe("done");
  });

  it("an MCP auth failure drops the bakery, retries at once, answers and posts the notice once", async () => {
    const { db, run } = await setup({ settings: { bakery: true } });
    const llm = fakeLlm([apiError(400, "MCP server bakery: 401 Unauthorized"), reply([text("Answer without bakery")])]);
    const bakery = fakeBakery();
    const d = deps(db, { llm, bakeryCfg: CFG, bakery });
    await processRun(run, d);

    expect(llm.calls).toHaveLength(2);
    expect((llm.calls[0] as { mcp_servers?: unknown }).mcp_servers).toBeDefined();
    expect((llm.calls[1] as { mcp_servers?: unknown }).mcp_servers).toBeUndefined();
    const s = sends(d.tg);
    expect(s.map(sentText)).toEqual([expect.stringContaining("Answer without bakery"), t("en", "bakeryUnavailableNotice")]);
    const done = await readRun(db, run.id);
    expect(done.status).toBe("done");
    expect(done.attempts).toBe(1); // the one claim; the bakery drop is not a retry
    expect(done.snapshot!.bakeryDropped).toBe(true);
    expect(done.sent.bakeryNoticeSent).toBe(true);
    expect(logged("run.bakery_dropped")).toHaveLength(1);

    await db.update(runs).set({ status: "running", leaseOwner: "A", leaseUntil: T0 }).where(eq(runs.id, run.id));
    const d2 = deps(db, { llm: fakeLlm([]), owner: "B", bakeryCfg: CFG, bakery });
    await processRun(await reclaim(db, "B"), d2);
    expect(sends(d2.tg)).toHaveLength(0);
  });

  it("a generic error is retried by later processes and fails with one apology on the third", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([new Error("socket hang up"), new Error("socket hang up"), new Error("socket hang up")]);
    const tg = fakeTg();

    await processRun(run, deps(db, { llm, tg }));
    let row = await readRun(db, run.id);
    expect([row.status, row.attempts, row.leaseOwner]).toEqual(["running", 1, null]);
    expect(row.snapshot).not.toBeNull();
    expect(sends(tg)).toHaveLength(0);

    await processRun(await reclaim(db, "B", T0), deps(db, { llm, tg, owner: "B" }));
    row = await readRun(db, run.id);
    expect([row.status, row.attempts]).toEqual(["running", 2]);

    await processRun(await reclaim(db, "C", T0), deps(db, { llm, tg, owner: "C" }));
    row = await readRun(db, run.id);
    expect(row.status).toBe("failed");
    expect(llm.calls).toHaveLength(3);
    const s = sends(tg);
    expect(s).toHaveLength(1);
    expect(sentText(s[0]!)).toBe(t("en", "runFailed"));
    expect(sentParams(s[0]!).reply_parameters.message_id).toBe(5);
  });

  it("a 400 that is not about MCP fails at once with the apology", async () => {
    const { db, run } = await setup({ settings: { bakery: true } });
    const llm = fakeLlm([apiError(400, "messages: roles must alternate")]);
    const d = deps(db, { llm, bakeryCfg: CFG, bakery: fakeBakery() });
    await processRun(run, d);
    const row = await readRun(db, run.id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1); // the one claim: a 400 is not retried
    expect(llm.calls).toHaveLength(1);
    expect(sends(d.tg).map(sentText)).toEqual([t("en", "runFailed")]);
  });

  it("an apology that can't be sent is logged and the run still ends failed", async () => {
    const { db, run } = await setup();
    const tg = fakeTg();
    tg.sendMessage = (async () => { throw new Error("telegram down"); }) as unknown as FakeTg["sendMessage"];
    await processRun(run, deps(db, { llm: fakeLlm([apiError(400, "bad request")]), tg }));
    expect((await readRun(db, run.id)).status).toBe("failed");
    expect(logged("run.failed_notice_failed")[0]).toMatchObject({ error: "telegram down" });
  });

  it("a failing chime run posts no apology", async () => {
    const { db, run } = await setup({ trigger: { type: "chime", requesterId: null, requesterName: null } });
    const llm = fakeLlm([apiError(400, "bad request")]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect((await readRun(db, run.id)).status).toBe("failed");
    expect(sends(d.tg)).toHaveLength(0);
  });

  it("an unexpected stop reason fails the run with the apology", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("calling"), { type: "tool_use", id: "t1", name: "x", input: {} }], "tool_use")]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect((await readRun(db, run.id)).status).toBe("failed");
    expect(sends(d.tg).map(sentText)).toEqual([t("en", "runFailed")]);
    expect(logged("run.unexpected_stop")).toHaveLength(1);
  });

  it("a lost lease stops the run without sending", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("Hello")])]);
    const stream = llm.stream.bind(llm);
    llm.stream = async (p) => {
      // Another instance takes the run over while this call is in flight.
      await db.update(runs).set({ leaseOwner: "B" }).where(eq(runs.id, run.id));
      return stream(p);
    };
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(sends(d.tg)).toHaveLength(0);
    const row = await readRun(db, run.id);
    expect([row.status, row.leaseOwner, row.steps]).toEqual(["running", "B", 0]);
    expect(logged("run.lease_lost")).toHaveLength(1);
  });

  it("an inactive group fails the run without calling Claude", async () => {
    const { db, run } = await setup();
    await setGroupActive(db, CHAT, false);
    const llm = fakeLlm([]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(llm.calls).toHaveLength(0);
    expect(sends(d.tg)).toHaveLength(0);
    const row = await readRun(db, run.id);
    expect([row.status, row.error]).toEqual(["failed", "inactive"]);
  });

  it("part 2 of 3 fails: the retry sends only parts 2 and 3, part 1 exactly once", async () => {
    const { db, run } = await setup();
    const para = (c: string) => c.repeat(3000);
    const long = [para("a"), para("b"), para("c")].join("\n\n");
    const llm = fakeLlm([reply([text(long)])]);
    const tg = fakeTg();
    const send = tg.sendMessage.bind(tg);
    let down = true;
    tg.sendMessage = (async (...args: Parameters<FakeTg["sendMessage"]>) => {
      // Part 2 can't be delivered at all (MarkdownV2 and the plain fallback) on the first attempt.
      if (down && String(args[1]).startsWith("b")) throw new Error("socket hang up");
      return send(...args);
    }) as FakeTg["sendMessage"];

    await processRun(run, deps(db, { llm, tg }));
    let row = await readRun(db, run.id);
    expect([row.status, row.leaseOwner]).toEqual(["running", null]);
    expect(row.sent).toMatchObject({ answered: false, answerIds: [1000], partsSent: 1 });

    down = false;
    await processRun(await reclaim(db, "B", later(2)), deps(db, { llm: fakeLlm([]), tg, owner: "B" }));
    row = await readRun(db, run.id);
    expect(row.status).toBe("done");
    expect(row.sent).toMatchObject({ answered: true, answerIds: [1000, 1001, 1002], partsSent: 3 });
    const bodies = sends(tg).map(sentText);
    expect(bodies.filter((b) => b.startsWith("a"))).toHaveLength(1);
    expect(bodies.filter((b) => b.startsWith("b"))).toHaveLength(1);
    expect(bodies.filter((b) => b.startsWith("c"))).toHaveLength(1);
    // Only the first part replies to the trigger; resumed parts don't.
    expect(sentParams(sends(tg)[0]!).reply_parameters.message_id).toBe(5);
    expect(sentParams(sends(tg).at(-1)!).reply_parameters).toBeUndefined();
    // Each delivered part is one bot row with exactly the text it went out as.
    expect((await getMessage(db, CHAT, 1000))!.text).toBe(para("a"));
    expect((await getMessage(db, CHAT, 1001))!.text).toBe(para("b"));
    expect((await getMessage(db, CHAT, 1002))!.text).toBe(para("c"));
  });

  it("a reaction to a message older than the window puts that message and its photo in the request", async () => {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: { ...defaultSettings("en"), historyWindow: 50 }, token: "tok" });
    await insertMessage(db, msg(CHAT, 1, { fromName: "Dana", text: "look at my cake", media: { kind: "photo", fileId: "tgcake", label: "photo" } }));
    for (let i = 2; i <= 120; i++) await insertMessage(db, msg(CHAT, i, { text: `chat ${i}` }));
    await createRun(db, {
      chatId: CHAT,
      threadId: null,
      trigger: { type: "reaction", messageId: 1, targetMessageId: 1, requesterId: 10, requesterName: "Avi", emoji: "👾" },
    });
    const run = (await claimNextRun(db, CHAT, "A", LEASE, T0))!;
    const llm = fakeLlm([reply([text("Lovely cake")])]);
    await processRun(run, deps(db, { llm }));

    const json = JSON.stringify(llm.calls[0]!.messages);
    expect(json).toContain("look at my cake");
    expect(json.indexOf("look at my cake")).toBeLessThan(json.indexOf("chat 120"));
    expect(llm.uploads).toContainEqual({ name: "1.jpg", mime: "image/jpeg" });
    expect(json).toContain('"file_id":"file_1"');
    expect(logged("run.focus_outside_window")[0]).toMatchObject({ message_ids: [1] });
  });

  it("an out-of-window target from before a forget stays forgotten", async () => {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: { ...defaultSettings("en"), historyWindow: 50 }, token: "tok" });
    await insertMessage(db, msg(CHAT, 1, { text: "secret old" }));
    for (let i = 2; i <= 120; i++) await insertMessage(db, msg(CHAT, i, { text: `chat ${i}` }));
    await db.update(groups).set({ forgetBefore: msg(CHAT, 1).date }).where(eq(groups.chatId, CHAT));
    await createRun(db, {
      chatId: CHAT,
      threadId: null,
      trigger: { type: "reaction", messageId: 1, targetMessageId: 1, requesterId: 10, requesterName: "Avi", emoji: "👾" },
    });
    const llm = fakeLlm([reply([text("ok")])]);
    await processRun((await claimNextRun(db, CHAT, "A", LEASE, T0))!, deps(db, { llm }));
    expect(JSON.stringify(llm.calls[0]!.messages)).not.toContain("secret old");
  });

  it("a reaction to the bot's own message that heads the window puts that message in the request", async () => {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: defaultSettings("en"), token: "tok" });
    await insertMessage(db, msg(CHAT, 1, { isBot: true, fromId: null, fromName: "Bot", text: "the secret recipe is butter" }));
    await insertMessage(db, msg(CHAT, 2, { text: "thanks" }));
    await createRun(db, {
      chatId: CHAT,
      threadId: null,
      trigger: { type: "reaction", messageId: 1, targetMessageId: 1, requesterId: 10, requesterName: "Avi", emoji: "👾" },
    });
    const llm = fakeLlm([reply([text("glad")])]);
    await processRun((await claimNextRun(db, CHAT, "A", LEASE, T0))!, deps(db, { llm }));
    const json = JSON.stringify(llm.calls[0]!.messages);
    expect(json).toContain("the secret recipe is butter");
    expect(json.indexOf("the secret recipe")).toBeLessThan(json.indexOf("thanks"));
  });

  it("a reply to a bot message that heads the window puts that message in the request", async () => {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: defaultSettings("en"), token: "tok" });
    await insertMessage(db, msg(CHAT, 1, { isBot: true, fromId: null, fromName: "Bot", text: "the secret recipe is butter" }));
    await insertMessage(db, msg(CHAT, 2, { text: "and the sugar?", replyToId: 1 }));
    await createRun(db, {
      chatId: CHAT,
      threadId: null,
      trigger: { type: "reply", messageId: 2, targetMessageId: 2, requesterId: 10, requesterName: "Avi" },
    });
    const llm = fakeLlm([reply([text("two cups")])]);
    await processRun((await claimNextRun(db, CHAT, "A", LEASE, T0))!, deps(db, { llm }));
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain("the secret recipe is butter");
  });

  it("a permanent failure on part 2 posts the cut-short notice, not the apology", async () => {
    const { db, run } = await setup();
    const para = (c: string) => c.repeat(3000);
    const llm = fakeLlm([reply([text([para("a"), para("b")].join("\n\n"))])]);
    const tg = fakeTg();
    const send = tg.sendMessage.bind(tg);
    tg.sendMessage = (async (...args: Parameters<FakeTg["sendMessage"]>) => {
      if (String(args[1]).startsWith("b")) throw new GrammyError("refused", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {});
      return send(...args);
    }) as FakeTg["sendMessage"];
    await processRun(run, deps(db, { llm, tg }));
    expect((await readRun(db, run.id)).status).toBe("failed");
    const bodies = sends(tg).map(sentText);
    expect(bodies.at(-1)).toBe(t("en", "cutShort"));
    expect(bodies).not.toContain(t("en", "runFailed"));
  });

  it("a send refused because the group became a supergroup releases the run for the new chat, no apology", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("hello")])]);
    const tg = fakeTg();
    tg.sendMessage = (async () => {
      throw new GrammyError(
        "upgraded",
        { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001 } },
        "sendMessage",
        {},
      );
    }) as FakeTg["sendMessage"];
    await processRun(run, deps(db, { llm, tg }));
    const row = await readRun(db, run.id);
    expect([row.status, row.leaseOwner]).toEqual(["running", null]);
    expect(logged("run.chat_migrated")[0]).toMatchObject({ migrate_to_chat_id: -1001 });
    expect(logged("run.failed")).toHaveLength(0);
  });

  it("the sources message fails: the retry sends only it, the last part is not repeated", async () => {
    const { db, run } = await setup();
    const sources = [1, 2, 3, 4, 5].map((n) => cite(`https://example.com/${n}/${"p".repeat(200)}`, `Source ${n} ${"t".repeat(100)}`));
    const llm = fakeLlm([reply([text("z".repeat(3400), sources)])]);
    const tg = fakeTg();
    const send = tg.sendMessage.bind(tg);
    let down = true;
    tg.sendMessage = (async (...args: Parameters<FakeTg["sendMessage"]>) => {
      if (down && String(args[1]).startsWith("**>")) throw new Error("socket hang up");
      return send(...args);
    }) as FakeTg["sendMessage"];
    await processRun(run, deps(db, { llm, tg }));
    expect((await readRun(db, run.id)).status).toBe("running");
    down = false;
    await processRun(await reclaim(db, "B", later(2)), deps(db, { llm: fakeLlm([]), tg, owner: "B" }));
    const row = await readRun(db, run.id);
    expect(row.status).toBe("done");
    const bodies = sends(tg).map(sentText);
    expect(bodies.filter((b) => b.startsWith("z"))).toHaveLength(1);
    expect(bodies.filter((b) => b.startsWith("**>"))).toHaveLength(1);
    expect(row.sent.tailSent).toBe(true);
  });

  it("an empty answer to a mention sends the localized no-answer notice", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([{ type: "thinking", thinking: "", signature: "sig" }])]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(sends(d.tg)).toHaveLength(1);
    expect(sentText(sends(d.tg)[0]!)).toContain("Please ask again");
    expect(sentParams(sends(d.tg)[0]!).reply_parameters.message_id).toBe(5);
    expect((await readRun(db, run.id)).status).toBe("done");
    expect(logged("run.empty_answer")).toHaveLength(1);
  });

  it("logs each bakery tool error result with its scrubbed text", async () => {
    const { db, run } = await setup({ settings: { bakery: true } });
    const content = [
      { type: "mcp_tool_use", id: "u1", name: "get_sales", server_name: "bakery", input: {} },
      { type: "mcp_tool_result", tool_use_id: "u1", is_error: true, content: [{ type: "text", text: "401 bad key bmcp_leaked123" }] },
      text("The bakery isn't answering."),
    ];
    const d = deps(db, { llm: fakeLlm([reply(content)]), bakeryCfg: CFG, bakery: fakeBakery() });
    await processRun(run, d);
    const [e] = logged("run.bakery_tool_error");
    expect(e).toMatchObject({ tool_use_id: "u1", text: "401 bad key [bakery-key]" });
  });

  it("a run claimed more than 3 times (each earlier claim died) fails with the apology without calling Claude", async () => {
    const { db } = await setup();
    // Three earlier claims whose process died mid-run (the lease simply expired each time).
    await reclaim(db, "B", later(1));
    await reclaim(db, "C", later(2));
    const run = await reclaim(db, "D", later(3));
    expect(run.attempts).toBe(4);
    const llm = fakeLlm([]);
    const d = deps(db, { llm, owner: "D" });
    await processRun(run, d);
    expect(llm.calls).toHaveLength(0);
    const row = await readRun(db, run.id);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("attempts_exhausted");
    expect(sends(d.tg).map(sentText)).toEqual([t("en", "runFailed")]);
  });

  it("a failing bot-name lookup goes through the run's error handling and releases the lease", async () => {
    const { db, run } = await setup();
    const d = deps(db, { llm: fakeLlm([]), botIdentity: async () => { throw new Error("getMe failed"); } });
    await processRun(run, d);
    const row = await readRun(db, run.id);
    expect([row.status, row.leaseOwner]).toEqual(["running", null]);
    expect(logged("run.retry_later")).toHaveLength(1);
  });

  it("a chime run is skipped when the bot answered after it was created", async () => {
    const { db } = await setup();
    const db2 = db;
    await db2.update(runs).set({ status: "done", leaseOwner: null }).where(eq(runs.chatId, CHAT));
    await createRun(db2, { chatId: CHAT, threadId: null, trigger: { type: "chime", messageId: 5, targetMessageId: 5, requesterId: null, requesterName: null } });
    const run = (await claimNextRun(db2, CHAT, "A", LEASE, T0))!;
    await insertMessage(db2, msg(CHAT, 900, { isBot: true, fromId: null, text: "answer", date: new Date(run.createdAt.getTime() + 1000) }));
    const llm = fakeLlm([]);
    const d = deps(db2, { llm });
    await processRun(run, d);
    expect(llm.calls).toHaveLength(0);
    expect(sends(d.tg)).toHaveLength(0);
    const row = await readRun(db2, run.id);
    expect([row.status, row.error]).toEqual(["done", "skipped: bot_spoke_since"]);
    expect(logged("run.chime_skipped")[0]).toMatchObject({ reason: "bot_spoke_since" });
  });

  it("a chime run is skipped when a user triggered a run after it was created", async () => {
    const { db } = await setup();
    await db.update(runs).set({ status: "done", leaseOwner: null }).where(eq(runs.chatId, CHAT));
    await createRun(db, { chatId: CHAT, threadId: null, trigger: { type: "chime", messageId: 5, targetMessageId: 5, requesterId: null, requesterName: null } });
    const run = (await claimNextRun(db, CHAT, "A", LEASE, T0))!;
    await db.execute(sql`select pg_sleep(0.01)`);
    await createRun(db, { chatId: CHAT, threadId: null, trigger: { type: "mention", messageId: 6, targetMessageId: 6, requesterId: 1, requesterName: "x" } });
    const llm = fakeLlm([]);
    await processRun(run, deps(db, { llm }));
    expect(llm.calls).toHaveLength(0);
    expect((await readRun(db, run.id)).error).toBe("skipped: user_run_since");
  });

  it("a run that fails after answering with the bakery dropped still posts the bakery notice", async () => {
    const { db, run } = await setup({ settings: { bakery: true } });
    const tg = fakeTg();
    const send = tg.sendMessage.bind(tg);
    // The card (its fallback summary is "הצעה") is refused for good: the run fails after the answer.
    tg.sendMessage = (async (...args: Parameters<FakeTg["sendMessage"]>) => {
      if (args[1] === "הצעה") throw new GrammyError("refused", { ok: false, error_code: 400, description: "Bad Request" }, "sendMessage", {});
      return send(...args);
    }) as FakeTg["sendMessage"];
    const llm = fakeLlm([apiError(400, "MCP server bakery: 401 Unauthorized"), reply(propose)]);
    const d = deps(db, { llm, tg, bakeryCfg: CFG, bakery: fakeBakery() });
    await processRun(run, d);
    expect((await readRun(db, run.id)).status).toBe("failed");
    const bodies = sends(d.tg).map(sentText);
    expect(bodies[0]).toContain("approve it on the card");
    expect(bodies).toContain(t("en", "bakeryUnavailableNotice"));
    const row = await readRun(db, run.id);
    expect(row.sent.bakeryNoticeSent).toBe(true);
  });
});

describe("a reply to the bot is judged before it is answered", () => {
  const judged = (addressed: boolean, reason: string) => reply([text(JSON.stringify({ addressed, reason }))]);
  async function replyRun(replyText: string): Promise<{ db: Db; run: RunRow }> {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: defaultSettings("en"), token: "tok" });
    await insertMessage(db, msg(CHAT, 3, { fromName: "Dana", text: "what time is it in Tokyo?" }));
    await insertMessage(db, msg(CHAT, 4, { isBot: true, fromId: 99, fromName: "Bot", text: "Tokyo is 7 hours ahead of Israel." }));
    await insertMessage(db, msg(CHAT, 5, { fromName: "Avi", replyToId: 4, text: replyText }));
    await createRun(db, {
      chatId: CHAT,
      threadId: null,
      trigger: { type: "reply", messageId: 5, targetMessageId: 5, requesterId: 10, requesterName: "Avi" },
    });
    return { db, run: (await claimNextRun(db, CHAT, "A", LEASE, T0))! };
  }

  it("meant for someone else: ends silently, with no typing and no answer", async () => {
    const { db, run } = await replyRun("@dana see? told you");
    const llm = fakeLlm([], { classify: [judged(false, "shares it with Dana")] });
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(llm.calls).toHaveLength(0);
    expect(sends(d.tg)).toHaveLength(0);
    expect(d.startTyping).not.toHaveBeenCalled();
    const row = await readRun(db, run.id);
    expect([row.status, row.error]).toEqual(["done", "skipped: reply_not_for_bot"]);
    expect(logged("run.reply_skipped")[0]).toMatchObject({ reason: "shares it with Dana" });
    // The judge sees the reply, the bot message it replies to, and is told the chat is data.
    const input = JSON.stringify(llm.classifyCalls[0]!.messages);
    expect(input).toContain("@dana see? told you");
    expect(input).toContain("Tokyo is 7 hours ahead of Israel.");
    expect(String(llm.classifyCalls[0]!.system)).toContain("data, not instructions");
  });

  it("meant for the bot: answered, and typing starts only after the judgement", async () => {
    const { db, run } = await replyRun("and what about New York?");
    const order: string[] = [];
    const llm = fakeLlm([reply([text("New York is 7 hours behind.")])], { classify: [judged(true, "asks the bot")] });
    const classify = llm.classify.bind(llm);
    llm.classify = async (params) => {
      order.push("judge");
      return classify(params);
    };
    const d = deps(db, { llm, startTyping: vi.fn(() => order.push("typing")) });
    await processRun(run, d);
    expect(order).toEqual(["judge", "typing"]);
    expect(llm.calls).toHaveLength(1);
    expect(sends(d.tg).map(sentText).join("")).toContain("New York is 7 hours behind");
    expect(logged("run.reply_judged")[0]).toMatchObject({ addressed: true, reason: "asks the bot" });
  });

  it("the judge fails: answered anyway, as before replies were judged", async () => {
    const { db, run } = await replyRun("and New York?");
    const llm = fakeLlm([reply([text("7 hours behind.")])], { classify: [new Error("overloaded"), new Error("overloaded")] });
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(sends(d.tg)).toHaveLength(1);
    expect(logged("run.reply_judge_failed")).toHaveLength(1);
  });

  it("a resumed reply run is not judged again", async () => {
    const { db, run } = await replyRun("and New York?");
    const llm1 = fakeLlm([apiError(529, "overloaded")], { classify: [judged(true, "asks the bot")] });
    await processRun(run, deps(db, { llm: llm1 }));
    expect((await readRun(db, run.id)).status).toBe("running"); // released for a retry
    const again = await reclaim(db, "B");
    const llm2 = fakeLlm([reply([text("7 hours behind.")])]);
    const d2 = deps(db, { llm: llm2, owner: "B" });
    await processRun(again, d2);
    expect(llm2.classifyCalls).toHaveLength(0);
    expect(d2.startTyping).toHaveBeenCalledTimes(1);
    expect(sends(d2.tg)).toHaveLength(1);
  });

  it("the judge reads the thread up to the reply, even when newer messages arrived meanwhile", async () => {
    const { db, run } = await replyRun("@dana see?");
    for (let i = 6; i <= 20; i++) await insertMessage(db, msg(CHAT, i, { fromName: "Avi", text: `later ${i}` }));
    const llm = fakeLlm([], { classify: [judged(false, "for Dana")] });
    await processRun(run, deps(db, { llm }));
    const input = JSON.stringify(llm.classifyCalls[0]!.messages);
    expect(input).toContain("what time is it in Tokyo?");
    expect(input).not.toContain("later 20");
  });

  it("the judge sees a tag of a member without a username as @Name", async () => {
    const { db, run } = await replyRun("ישועה הכוונה הייתה 900 גרם?");
    await db.update(messagesTable).set({
      entities: [{ type: "text_mention", offset: 0, length: 5, user: { id: 7, is_bot: false, first_name: "Yeshua" } }],
    }).where(sql`${messagesTable.chatId} = ${CHAT} and ${messagesTable.messageId} = 5`);
    const llm = fakeLlm([], { classify: [judged(false, "asks his wife")] });
    await processRun(run, deps(db, { llm }));
    expect(JSON.stringify(llm.classifyCalls[0]!.messages)).toContain("@ישועה הכוונה");
    expect(String(llm.classifyCalls[0]!.system)).toContain("@ is a tag");
  });

  it("the judge knows the bot's name, so a reply that names it counts as addressed to it", async () => {
    const { db, run } = await replyRun("Razik, and in Russian?");
    const llm = fakeLlm([reply([text("По-русски...")])], { classify: [judged(true, "names the bot")] });
    await processRun(run, deps(db, { llm, botIdentity: async () => ({ username: "justachatbot", firstName: "Razik Chat Bot" }) }));
    const system = String(llm.classifyCalls[0]!.system);
    expect(system).toContain("Razik Chat Bot");
    expect(system).toContain("@justachatbot");
  });

  it("a verdict is saved, so a retried run is not judged again", async () => {
    const { db, run } = await replyRun("and New York?");
    const llm = fakeLlm([apiError(529, "overloaded")], { classify: [judged(true, "asks the bot")] });
    await processRun(run, deps(db, { llm }));
    expect((await readRun(db, run.id)).sent.judged).toBe(true);

    const fresh = await replyRun("and New York?");
    await fresh.db.update(runs).set({ sent: { answerIds: [], answered: false, cards: [], judged: true } }).where(eq(runs.id, fresh.run.id));
    const [row] = await fresh.db.select().from(runs).where(eq(runs.id, fresh.run.id));
    const llm2 = fakeLlm([reply([text("7 hours behind.")])]);
    const d2 = deps(fresh.db, { llm: llm2 });
    await processRun(row!, d2);
    expect(llm2.classifyCalls).toHaveLength(0);
    expect(sends(d2.tg)).toHaveLength(1);
  });

  it("the judge's failure logs carry the run", async () => {
    const { db, run } = await replyRun("and New York?");
    const llm = fakeLlm([reply([text("7 hours behind.")])], { classify: [new Error("overloaded"), new Error("overloaded")] });
    await processRun(run, deps(db, { llm }));
    expect(logged("run.reply_judge_invalid")[0]).toMatchObject({ run_id: run.id, chat_id: CHAT });
    expect(logged("run.reply_judge_failed")[0]).toMatchObject({ run_id: run.id, chat_id: CHAT });
  });

  it("a mention is never judged and types right away; a chime run never types", async () => {
    const { db, run } = await setup();
    const llm = fakeLlm([reply([text("Hi")])]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(llm.classifyCalls).toHaveLength(0);
    expect(d.startTyping).toHaveBeenCalledTimes(1);

    const c = await setup({ trigger: { type: "chime", requesterId: null, requesterName: null } });
    const dc = deps(c.db, { llm: fakeLlm([reply([text("Fun fact")])]) });
    await processRun(c.run, dc);
    expect(dc.startTyping).not.toHaveBeenCalled();
  });
});

describe("a message with no tag and no reply to the bot is judged before it is answered", () => {
  const judged = (addressed: boolean, reason: string) => reply([text(JSON.stringify({ addressed, reason }))]);
  const RAZIK = { username: "justachatbot", firstName: "Razik Chat Bot" };
  // The bot answered Dana; Avi then writes without tagging it.
  async function messageRun(messageText: string, o: { settings?: Record<string, unknown>; replyToId?: number } = {}): Promise<{ db: Db; run: RunRow }> {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: { ...defaultSettings("en"), ...o.settings }, token: "tok" });
    await insertMessage(db, msg(CHAT, 3, { fromName: "Dana", text: "@justachatbot what is yudane?" }));
    await insertMessage(db, msg(CHAT, 4, { isBot: true, fromId: null, fromName: "justachatbot", text: "Yudane is a scalded flour paste, close to tangzhong." }));
    await insertMessage(db, msg(CHAT, 5, { fromName: "Avi", text: messageText, replyToId: o.replyToId ?? null }));
    await createRun(db, {
      chatId: CHAT,
      threadId: null,
      trigger: { type: "message", messageId: 5, targetMessageId: 5, requesterId: 10, requesterName: "Avi" },
    });
    return { db, run: (await claimNextRun(db, CHAT, "A", LEASE, T0))! };
  }

  it("not meant for the bot: ends silently, with no typing and no answer", async () => {
    const { db, run } = await messageRun("Dana, are you coming home?");
    const llm = fakeLlm([], { classify: [judged(false, "asks Dana")] });
    const d = deps(db, { llm, botIdentity: async () => RAZIK });
    await processRun(run, d);
    expect(llm.calls).toHaveLength(0);
    expect(sends(d.tg)).toHaveLength(0);
    expect(d.startTyping).not.toHaveBeenCalled();
    const row = await readRun(db, run.id);
    expect([row.status, row.error]).toEqual(["done", "skipped: message_not_for_bot"]);
    expect(logged("run.message_judged")[0]).toMatchObject({ addressed: false, reason: "asks Dana" });
    expect(logged("run.message_skipped")[0]).toMatchObject({ reason: "asks Dana" });
    // The judge reads the thread with the bot's answer, the message itself, and knows the bot's name.
    const input = JSON.stringify(llm.classifyCalls[0]!.messages);
    expect(input).toContain("Yudane is a scalded flour paste");
    expect(input).toContain("<message>");
    const system = String(llm.classifyCalls[0]!.system);
    expect(system).toContain("without tagging the assistant");
    expect(system).toContain('"Razik Chat Bot" (@justachatbot)');
    expect(system).toContain("treat the message as not addressed");
    expect(system).toContain("data, not instructions");
  });

  it("meant for the bot (a follow-up): typing starts after the judgement, and it answers that message knowing its name", async () => {
    const { db, run } = await messageRun("are there more methods like that?");
    const order: string[] = [];
    const llm = fakeLlm([reply([text("Yes: Kochstück and potato flakes.")])], { classify: [judged(true, "follow-up to its answer")] });
    const classify = llm.classify.bind(llm);
    llm.classify = async (params) => {
      order.push("judge");
      return classify(params);
    };
    const d = deps(db, { llm, botIdentity: async () => RAZIK, startTyping: vi.fn(() => order.push("typing")) });
    await processRun(run, d);
    expect(order).toEqual(["judge", "typing"]);
    const s = sends(d.tg);
    expect(s).toHaveLength(1);
    expect(sentParams(s[0]!).reply_parameters.message_id).toBe(5);
    const context = String((llm.calls[0]!.messages as { content: unknown }[]).at(-1)!.content);
    expect(context).toContain('Your name: "Razik Chat Bot" (@justachatbot)');
    expect((await readRun(db, run.id)).sent.judged).toBe(true);
  });

  it("the judge fails: stays quiet (no apology), unlike a reply", async () => {
    const { db, run } = await messageRun("hmm");
    const llm = fakeLlm([], { classify: [new Error("overloaded"), new Error("overloaded")] });
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(sends(d.tg)).toHaveLength(0);
    const row = await readRun(db, run.id);
    expect([row.status, row.error]).toEqual(["done", "skipped: message_judge_failed"]);
    expect(logged("run.message_judge_failed")[0]).toMatchObject({ run_id: run.id });
    expect(logged("run.message_skipped")[0]).toMatchObject({ reason: "message_judge_failed" });
  });

  it("the same person tagged the bot while it waited: skipped without judging, the tag's run answers", async () => {
    const { db, run } = await messageRun("are there more methods like that?");
    await insertMessage(db, msg(CHAT, 6, { fromName: "Avi", text: "@justachatbot", replyToId: 5 }));
    await createRun(db, { chatId: CHAT, threadId: null, trigger: { type: "mention", messageId: 6, targetMessageId: 6, requesterId: 10, requesterName: "Avi" } });
    const llm = fakeLlm([]);
    const d = deps(db, { llm });
    await processRun(run, d);
    expect(llm.classifyCalls).toHaveLength(0);
    expect(sends(d.tg)).toHaveLength(0);
    expect((await readRun(db, run.id)).error).toBe("skipped: superseded");
    expect(logged("run.message_skipped")[0]).toMatchObject({ reason: "superseded" });
  });

  it("a newer run that may not answer it does not skip it: someone else's tag, the same person's reply, a tag in another topic", async () => {
    for (const trigger of [
      { type: "mention" as const, requesterId: 11, threadId: null },
      { type: "reply" as const, requesterId: 10, threadId: null },
      { type: "mention" as const, requesterId: 10, threadId: 77 },
    ]) {
      const { db, run } = await messageRun("are there more methods like that?");
      await createRun(db, {
        chatId: CHAT,
        threadId: trigger.threadId,
        trigger: { type: trigger.type, messageId: 6, targetMessageId: 6, requesterId: trigger.requesterId, requesterName: "x" },
      });
      const llm = fakeLlm([], { classify: [judged(false, "x")] });
      await processRun(run, deps(db, { llm }));
      expect(llm.classifyCalls).toHaveLength(1);
    }
  });

  it("an earlier run already answered it: the judge sees what the bot posted since", async () => {
    const { db, run } = await messageRun("and for 16 rolls?");
    await insertMessage(db, msg(CHAT, 6, { isBot: true, fromId: null, fromName: "justachatbot", text: "For 16 rolls: 1227 g flour.", replyToId: 3 }));
    const llm = fakeLlm([], { classify: [judged(false, "already answered")] });
    await processRun(run, deps(db, { llm }));
    const input = String(llm.classifyCalls[0]!.messages![0]!.content);
    expect(input).toMatch(/<assistant_since>\n\[[0-9:]+\] Bot \(replying to "Dana": «@justachatbot what is yudane\?»\): For 16 rolls: 1227 g flour\.\n<\/assistant_since>/);
    expect(String(llm.classifyCalls[0]!.system)).toContain("answering again would repeat it");
  });

  it("a reply to a bakery card (never stored) shows the judge the card, from the copy sent with the reply", async () => {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: defaultSettings("en"), token: "tok" });
    const repliedTo = { fromName: "Razik", isBot: true, text: "Proposal: bread price 30", entities: null, label: null, date: "2026-01-01T00:00:00.000Z" };
    await insertMessage(db, msg(CHAT, 5, { fromName: "Avi", text: "why 30?", replyToId: 40, repliedTo }));
    await createRun(db, { chatId: CHAT, threadId: null, trigger: { type: "reply", messageId: 5, targetMessageId: 5, requesterId: 10, requesterName: "Avi" } });
    const llm = fakeLlm([reply([text("Because flour went up.")])], { classify: [judged(true, "asks the bot")] });
    await processRun((await claimNextRun(db, CHAT, "A", LEASE, T0))!, deps(db, { llm }));
    expect(String(llm.classifyCalls[0]!.messages![0]!.content)).toContain("<replied_to>\nBot: Proposal: bread price 30\n</replied_to>");
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain('<replied_to_full msg=\\"5\\" self=\\"true\\">Proposal: bread price 30</replied_to_full>');
  });

  it("a message run that fails before it is judged posts no apology; once judged, it does", async () => {
    const { db, run } = await messageRun("hmm");
    await reclaim(db, "B", later(1));
    await reclaim(db, "C", later(2));
    const exhausted = await reclaim(db, "D", later(3));
    const d = deps(db, { llm: fakeLlm([]), owner: "D" });
    await processRun(exhausted, d);
    expect((await readRun(db, run.id)).status).toBe("failed");
    expect(sends(d.tg)).toHaveLength(0);

    const j = await messageRun("are there more methods like that?");
    const d2 = deps(j.db, { llm: fakeLlm([apiError(400, "bad request")], { classify: [judged(true, "follow-up")] }) });
    await processRun(j.run, d2);
    expect(sends(d2.tg).map(sentText)).toEqual([t("en", "runFailed")]);
  });

  it("the bakery line reaches the judge only when the bakery is on and configured", async () => {
    const on = await messageRun("honey rolls recipe for 16 rolls of 150 g", { settings: { bakery: true } });
    const llm = fakeLlm([], { classify: [judged(false, "x")] });
    await processRun(on.run, deps(on.db, { llm, bakeryCfg: CFG }));
    expect(String(llm.classifyCalls[0]!.system)).toContain("bakery's data");
    const off = await messageRun("honey rolls recipe", { settings: { bakery: true } });
    const llm2 = fakeLlm([], { classify: [judged(false, "x")] });
    await processRun(off.run, deps(off.db, { llm: llm2 }));
    expect(String(llm2.classifyCalls[0]!.system)).not.toContain("bakery's data");
  });

  it("a reply to another member: the judge sees what it replies to", async () => {
    const { db, run } = await messageRun("yes, it's softer", { replyToId: 3 });
    const llm = fakeLlm([], { classify: [judged(false, "answers Dana")] });
    await processRun(run, deps(db, { llm }));
    const input = JSON.stringify(llm.classifyCalls[0]!.messages);
    expect(input).toContain("<replied_to>");
    expect(input).toContain('\\"Avi\\" (replying to \\"Dana\\"');
  });
});

describe("replies carry what they reply to", () => {
  it("the answered message carries its replied-to bot message in full and the quoted words", async () => {
    const db = await testDb();
    await upsertGroup(db, { chatId: CHAT, title: "Family", settings: defaultSettings("en"), token: "tok" });
    const long = `First paragraph about tangzhong. ${"More detail. ".repeat(20)}Last paragraph about mashed potato.`;
    await insertMessage(db, msg(CHAT, 1, { text: "@Bot methods?" }));
    await insertMessage(db, msg(CHAT, 2, { isBot: true, fromId: null, fromName: "Bot", text: long, replyToId: 1 }));
    await insertMessage(db, msg(CHAT, 3, { text: "explain this", replyToId: 2, quote: "mashed potato" }));
    await createRun(db, { chatId: CHAT, threadId: null, trigger: { type: "mention", messageId: 3, targetMessageId: 3, requesterId: 10, requesterName: "Avi" } });
    const llm = fakeLlm([reply([text("Potato starch holds water too.")])]);
    await processRun((await claimNextRun(db, CHAT, "A", LEASE, T0))!, deps(db, { llm }));
    const all = JSON.stringify(llm.calls[0]!.messages);
    expect(all).toContain(`<replied_to self=\\"true\\">First paragraph about tangzhong.`);
    expect(all).toContain(`…</replied_to><quote>mashed potato</quote>explain this</msg>`);
    expect(all).toContain(`<replied_to_full msg=\\"3\\" self=\\"true\\">${long}</replied_to_full>`);
  });
});
