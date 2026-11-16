import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { eq } from "drizzle-orm";
import { GrammyError } from "grammy";
import { handleUpdate, type BotDeps } from "@/src/bot/dispatch";
import { getGroup } from "@/src/db/repo/groups";
import { getMessage } from "@/src/db/repo/messages";
import { groups, messages, runs } from "@/src/db/schema";
import { t } from "@/src/i18n";
import type { Db } from "@/src/db/types";
import { testDb } from "../helpers/db";
import { fakeTg, type FakeTg } from "../helpers/fake-tg";
import { seedGroup } from "../helpers/db-fixtures";
import { BOT, OWNER_ID, chatMember, groupMsg, msgUpdate, myChatMember, reactionUpdate, user } from "../helpers/fixtures";

let db: Db;
let tg: FakeTg;
let deps: BotDeps;
const enqueue = vi.fn();
const onHumanMessage = vi.fn();
const onCallback = vi.fn(async () => {});

const sent = () => tg.calls.filter((c) => c.method === "sendMessage");
const allRuns = () => db.select().from(runs);
let logSpy: MockInstance;
const logged = (event: string) =>
  logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === event);
const tgError = (code: number, description: string) =>
  new GrammyError("call failed", { ok: false, error_code: code, description }, "getChatMember", {});

afterEach(() => logSpy.mockRestore());

beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  db = await testDb();
  tg = fakeTg();
  tg.members.set(OWNER_ID, "member");
  enqueue.mockClear(); onHumanMessage.mockClear(); onCallback.mockClear();
  deps = {
    db, tg,
    env: { TELEGRAM_OWNER_ID: OWNER_ID, TELEGRAM_MINIAPP_SHORT_NAME: "settings" },
    botId: BOT.id, botUsername: "MyBot",
    enqueue, chime: { onHumanMessage }, onCallback,
    deleteFiles: vi.fn(), now: () => new Date(),
  };
});

const mention = (chatId: number, id: number, over: Record<string, unknown> = {}) =>
  msgUpdate(groupMsg(chatId, id, { text: "yo @MyBot", entities: [{ type: "mention", offset: 3, length: 6 }], ...over }));

describe("my_chat_member", () => {
  it("creates the group in the adder's language, welcomes with a settings button, hints once", async () => {
    await handleUpdate(myChatMember(-100, "left", "member", user(10, { language_code: "he" })), deps);
    const g = await getGroup(db, -100);
    expect((g!.settings as { language: string }).language).toBe("he");
    expect(g!.adminHintSent).toBe(true);
    expect(sent()).toHaveLength(2);
    const markup = (sent()[0]!.args[2] as { reply_markup: { inline_keyboard: { url: string }[][] } }).reply_markup;
    expect(markup.inline_keyboard[0]![0]!.url).toMatch(/^https:\/\/t\.me\/MyBot\/settings\?startapp=[A-Za-z0-9_-]{22}$/);
    // Removed and re-added: no second hint.
    await handleUpdate(myChatMember(-100, "member", "left", user(10)), deps);
    expect((await getGroup(db, -100))!.active).toBe(false);
    await handleUpdate(myChatMember(-100, "left", "member", user(10)), deps);
    expect(sent().filter((c) => String(c.args[1]).startsWith("Tip"))).toHaveLength(0);
    expect(sent()).toHaveLength(3); // only the welcome again
  });

  it("does not send the hint when added directly as admin", async () => {
    await handleUpdate(myChatMember(-100, "left", "administrator", user(10)), deps);
    expect(sent()).toHaveLength(1);
    expect((await getGroup(db, -100))!.adminHintSent).toBe(false);
  });

  it("leaves and stays inactive when the owner is not a member", async () => {
    tg.members.set(OWNER_ID, "left");
    await handleUpdate(myChatMember(-100, "left", "member", user(10)), deps);
    expect(tg.calls.some((c) => c.method === "leaveChat")).toBe(true);
    expect(String(sent()[0]!.args[1])).toContain("my owner");
    expect(await getGroup(db, -100)).toBeNull();
  });

  it("leaves when Telegram definitely refuses the membership check (400 user not found)", async () => {
    tg.getChatMember = async () => { throw tgError(400, "Bad Request: user not found"); };
    await handleUpdate(myChatMember(-100, "left", "member", user(10)), deps);
    expect(tg.calls.some((c) => c.method === "leaveChat")).toBe(true);
    expect(await getGroup(db, -100)).toBeNull();
  });

  it("throws on a transient membership-check failure (network, 429, 5xx) instead of leaving", async () => {
    for (const err of [new Error("socket hang up"), tgError(429, "Too Many Requests"), tgError(502, "Bad Gateway")]) {
      tg.getChatMember = async () => { throw err; };
      await expect(handleUpdate(myChatMember(-100, "left", "member", user(10)), deps)).rejects.toBe(err);
    }
    expect(tg.calls.some((c) => c.method === "leaveChat")).toBe(false);
    expect(sent()).toHaveLength(0);
    expect(await getGroup(db, -100)).toBeNull();
  });

  it("a redelivered join posts no second welcome", async () => {
    const u = myChatMember(-100, "left", "administrator", user(10));
    await handleUpdate(u, deps);
    await handleUpdate(u, deps);
    expect(sent()).toHaveLength(1);
  });

  it("accepts a restricted owner only while still a member", async () => {
    tg.getChatMember = async () => ({ status: "restricted", is_member: true }) as never;
    await handleUpdate(myChatMember(-100, "left", "member", user(10)), deps);
    expect(await getGroup(db, -100)).not.toBeNull();
    tg.getChatMember = async () => ({ status: "restricted", is_member: false }) as never;
    await handleUpdate(myChatMember(-200, "left", "member", user(10)), deps);
    expect(await getGroup(db, -200)).toBeNull();
  });

  it("deactivates when the bot is removed", async () => {
    await seedGroup(db, -100);
    await handleUpdate(myChatMember(-100, "member", "kicked", user(10)), deps);
    expect((await getGroup(db, -100))!.active).toBe(false);
  });

  it("leaves a channel", async () => {
    await handleUpdate(myChatMember(-5, "left", "administrator", user(10), "channel"), deps);
    expect(tg.calls.filter((c) => c.method === "leaveChat")).toHaveLength(1);
  });
});

describe("chat_member", () => {
  it("leaves when the owner leaves", async () => {
    await seedGroup(db, -100);
    await handleUpdate(chatMember(-100, user(OWNER_ID), "left"), deps);
    expect(tg.calls.some((c) => c.method === "leaveChat")).toBe(true);
    expect((await getGroup(db, -100))!.active).toBe(false);
  });
  it("ignores other members leaving", async () => {
    await seedGroup(db, -100);
    await handleUpdate(chatMember(-100, user(55), "left"), deps);
    expect(tg.calls.some((c) => c.method === "leaveChat")).toBe(false);
  });
});

describe("message", () => {
  it("creates an unknown group on its first message and stores it (owner is a member)", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    expect(await getGroup(db, -100)).not.toBeNull();
    expect(await getMessage(db, -100, 1)).not.toBeNull();
  });

  it("an unknown group without the owner is left, message not stored", async () => {
    tg.members.set(OWNER_ID, "left");
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    expect(tg.calls.some((c) => c.method === "leaveChat")).toBe(true);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("/settings and /settings@MyBot re-post the settings button in the thread, without a run or a chime ping", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    onHumanMessage.mockClear();
    const cmd = (id: number, text: string, over: Record<string, unknown> = {}) =>
      msgUpdate(groupMsg(-100, id, { text, entities: [{ type: "bot_command", offset: 0, length: text.length }], ...over }));
    await handleUpdate(cmd(2, "/settings"), deps);
    await handleUpdate(cmd(3, "/Settings@mybot", { is_topic_message: true, message_thread_id: 9 }), deps);
    const buttons = sent().slice(1);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.args[1]).toBe(t("en", "settingsCommand"));
      const p = b.args[2] as { reply_markup: { inline_keyboard: { text: string; url: string }[][] } };
      expect(p.reply_markup.inline_keyboard[0]![0]).toEqual({
        text: t("en", "settingsButton"),
        url: (sent()[0]!.args[2] as typeof p).reply_markup.inline_keyboard[0]![0]!.url,
      });
    }
    expect((buttons[0]!.args[2] as { reply_parameters: { message_id: number } }).reply_parameters.message_id).toBe(2);
    expect((buttons[1]!.args[2] as { message_thread_id: number }).message_thread_id).toBe(9);
    expect(await allRuns()).toHaveLength(0);
    expect(onHumanMessage).not.toHaveBeenCalled();
  });

  it("/settings@OtherBot does nothing special", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    const text = "/settings@OtherBot";
    await handleUpdate(msgUpdate(groupMsg(-100, 2, { text, entities: [{ type: "bot_command", offset: 0, length: text.length }] })), deps);
    expect(sent()).toHaveLength(1); // only the welcome
    expect(await allRuns()).toHaveLength(0);
  });

  it("service messages are not stored and don't ping the chime", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    onHumanMessage.mockClear();
    await handleUpdate(msgUpdate(groupMsg(-100, 2, { text: undefined, new_chat_members: [user(30)] })), deps);
    await handleUpdate(msgUpdate(groupMsg(-100, 3, { text: undefined, pinned_message: groupMsg(-100, 1) })), deps);
    expect(await getMessage(db, -100, 2)).toBeNull();
    expect(await getMessage(db, -100, 3)).toBeNull();
    expect(onHumanMessage).not.toHaveBeenCalled();
    expect(logged("bot.ignored").filter((l) => l.reason === "service_message")).toHaveLength(2);
  });

  it("in a forum topic, the topic root is not a reply target (no reply run, no reply_to)", async () => {
    const root = groupMsg(-100, 9, { from: BOT });
    await handleUpdate(msgUpdate(groupMsg(-100, 10, { is_topic_message: true, message_thread_id: 9, reply_to_message: root })), deps);
    expect((await getMessage(db, -100, 10))!.replyToId).toBeNull();
    expect(await allRuns()).toHaveLength(0);
  });

  it("a duplicate delivery gives one row and one run", async () => {
    const u = mention(-100, 1);
    await handleUpdate(u, deps);
    await handleUpdate(u, deps);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await allRuns()).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("a mention creates a mention run and enqueues with no delay", async () => {
    await handleUpdate(mention(-100, 1), deps);
    const [run] = await allRuns();
    expect(run!.trigger).toMatchObject({ type: "mention", messageId: 1, targetMessageId: 1, requesterId: 10 });
    expect(enqueue).toHaveBeenCalledWith(-100, 0);
    expect(onHumanMessage).not.toHaveBeenCalled();
  });

  it("an album mention waits 2 s", async () => {
    await handleUpdate(mention(-100, 1, { media_group_id: "alb" }), deps);
    expect(enqueue).toHaveBeenCalledWith(-100, 2000);
  });

  it("a reply to the bot creates a reply run", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 2, { reply_to_message: groupMsg(-100, 1, { from: BOT }) })), deps);
    expect((await allRuns())[0]!.trigger.type).toBe("reply");
  });

  it("a plain message pings the chime when enabled, not when disabled", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    expect(onHumanMessage).toHaveBeenCalledWith(-100);
    expect(await allRuns()).toHaveLength(0);
    onHumanMessage.mockClear();
    await db.update(groups).set({ settings: { chime: { enabled: false } } }).where(eq(groups.chatId, -100));
    await handleUpdate(msgUpdate(groupMsg(-100, 2)), deps);
    expect(onHumanMessage).not.toHaveBeenCalled();
  });

  it("ignores messages from bots", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1, { from: user(20, { is_bot: true }) })), deps);
    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await getGroup(db, -100)).toBeNull();
  });

  it("stores and triggers on an anonymous-admin mention (fake bot sender + sender_chat)", async () => {
    await handleUpdate(
      mention(-100, 1, { from: user(1087968824, { is_bot: true, first_name: "Group" }), sender_chat: { id: -100, type: "supergroup", title: "G" } }),
      deps,
    );
    const row = await getMessage(db, -100, 1);
    expect(row).not.toBeNull();
    expect(row!.isBot).toBe(false);
    expect((await allRuns())[0]!.trigger.type).toBe("mention");
  });

  it("answers a private message with groupsOnly in the sender's language", async () => {
    await handleUpdate(msgUpdate(groupMsg(5, 1, { chat: { id: 5, type: "private" }, from: user(5, { language_code: "ru" }) })), deps);
    expect(sent()).toHaveLength(1);
    expect(String(sent()[0]!.args[1])).toMatch(/[а-я]/);
  });

  it("migrate_to_chat_id moves the rows", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    await handleUpdate(msgUpdate(groupMsg(-100, 2, { text: undefined, migrate_to_chat_id: -1000 })), deps);
    expect(await getGroup(db, -1000)).not.toBeNull();
    expect(await getMessage(db, -1000, 1)).not.toBeNull();
    expect(await getGroup(db, -100)).toBeNull();
  });
});

describe("edited_message", () => {
  it("updates the text, never starts a run", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    const edited = groupMsg(-100, 1, { text: "yo @MyBot", entities: [{ type: "mention", offset: 3, length: 6 }] });
    await handleUpdate({ update_id: 500, edited_message: edited } as never, deps);
    expect((await getMessage(db, -100, 1))!.text).toBe("yo @MyBot");
    expect(await allRuns()).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("logs an edit of a message it never stored", async () => {
    await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps);
    await handleUpdate({ update_id: 501, edited_message: groupMsg(-100, 77, { text: "x" }) } as never, deps);
    expect(logged("bot.ignored").filter((l) => l.reason === "edit_unknown_message")).toHaveLength(1);
  });
});

describe("message_reaction", () => {
  beforeEach(async () => { await handleUpdate(msgUpdate(groupMsg(-100, 1)), deps); });

  it("two users reacting give one run", async () => {
    await handleUpdate(reactionUpdate(-100, 1, user(11, { first_name: "Dana" }), [], ["👾"]), deps);
    await handleUpdate(reactionUpdate(-100, 1, user(12), [], ["👾"]), deps);
    const rows = await allRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger).toMatchObject({ type: "reaction", targetMessageId: 1, requesterId: 11, requesterName: "Dana", emoji: "👾" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it("a non-trigger emoji gives no run", async () => {
    await handleUpdate(reactionUpdate(-100, 1, user(11), [], ["👍"]), deps);
    expect(await allRuns()).toHaveLength(0);
  });
  it("a reaction to an unstored message gives no run", async () => {
    await handleUpdate(reactionUpdate(-100, 999, user(11), [], ["👾"]), deps);
    expect(await allRuns()).toHaveLength(0);
  });
  it("an inactive group gives no run", async () => {
    await db.update(groups).set({ active: false }).where(eq(groups.chatId, -100));
    await handleUpdate(reactionUpdate(-100, 1, user(11), [], ["👾"]), deps);
    expect(await allRuns()).toHaveLength(0);
  });
});

describe("callback_query", () => {
  it("is handed to onCallback", async () => {
    const q = { id: "1", from: user(1), chat_instance: "x", data: "d" };
    await handleUpdate({ update_id: 1, callback_query: q } as never, deps);
    expect(onCallback).toHaveBeenCalledWith(q);
  });
  it("a redelivered callback is handed over again without crashing (the bakery owns idempotency)", async () => {
    const u = { update_id: 2, callback_query: { id: "2", from: user(1), chat_instance: "x", data: "mcp:approve:1" } } as never;
    await handleUpdate(u, deps);
    await handleUpdate(u, deps);
    expect(onCallback).toHaveBeenCalledTimes(2);
  });
});
