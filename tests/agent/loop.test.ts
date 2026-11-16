import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { processRun, type LoopDeps } from "@/src/agent/loop";
import { upsertGroup, setGroupActive } from "@/src/db/repo/groups";
import { getMessage, insertMessage, setAnthropicFileId } from "@/src/db/repo/messages";
import { claimNextRun, createRun, type RunRow } from "@/src/db/repo/runs";
import { groups, runs, type RunTrigger } from "@/src/db/schema";
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
    botName: "Bot",
    deleteFiles: vi.fn(),
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
    expect(String(msgs.at(-1)!.content)).toContain("Group: Family");
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
    expect(done.attempts).toBe(0);
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
    expect(row.attempts).toBe(0);
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
});
