import { eq, count } from "drizzle-orm";
import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import { msg, seedGroup } from "@/tests/helpers/db-fixtures";
import * as schema from "@/src/db/schema";
import {
  deleteChatMessages,
  getMessage,
  insertMessage,
  lastBotMessageAt,
  recentMessages,
  setAnthropicFileId,
  updateMessageText,
  windowMessages,
} from "@/src/db/repo/messages";

test("seq is per chat and monotonic; duplicates return null without advancing", async () => {
  const db = await testDb();
  await seedGroup(db, 1);
  await seedGroup(db, 2);
  const a = await insertMessage(db, msg(1, 100));
  const b = await insertMessage(db, msg(1, 101));
  const dup = await insertMessage(db, msg(1, 101));
  const c = await insertMessage(db, msg(1, 102));
  const other = await insertMessage(db, msg(2, 100));
  expect([a?.seq, b?.seq, c?.seq, other?.seq]).toEqual([1, 2, 3, 1]);
  expect(dup).toBeNull();
});

test("retention prunes beyond 800 and returns the file ids", async () => {
  const db = await testDb();
  await seedGroup(db);
  for (let i = 1; i <= 804; i++) await insertMessage(db, msg(1, i));
  await setAnthropicFileId(db, 1, 5, "file_5");
  const last = await insertMessage(db, msg(1, 805));
  expect(last?.seq).toBe(805);
  expect(last?.pruned).toContain("file_5");
  const [row] = await db.select({ n: count() }).from(schema.messages).where(eq(schema.messages.chatId, 1));
  expect(row?.n).toBe(800);
}, 60000);

async function fill(n: number, mk?: (i: number) => Partial<ReturnType<typeof msg>>) {
  const db = await testDb();
  await seedGroup(db);
  for (let i = 1; i <= n; i++) await insertMessage(db, msg(1, i, mk?.(i)));
  return db;
}
const win = (db: Awaited<ReturnType<typeof testDb>>, extra = {}) =>
  windowMessages(db, { chatId: 1, threadId: null, window: 100, after: null, ...extra });

test("window start steps by 20", async () => {
  let db = await fill(130);
  let w = await win(db);
  expect([w[0]?.seq, w.at(-1)?.seq]).toEqual([21, 130]);
  db = await fill(139);
  expect((await win(db))[0]?.seq).toBe(21);
  db = await fill(140);
  expect((await win(db))[0]?.seq).toBe(41);
  db = await fill(50);
  w = await win(db);
  expect([w[0]?.seq, w.length]).toEqual([1, 50]);
});

test("window filters by thread and after", async () => {
  const db = await fill(30, (i) => ({ threadId: i % 2 === 0 ? 7 : null }));
  const t = await win(db, { threadId: 7 });
  expect(t.length).toBe(15);
  expect(t.every((m) => m.threadId === 7)).toBe(true);
  // A null thread (a forum's General) reads only General, not every topic.
  const general = await win(db);
  expect(general.length).toBe(15);
  expect(general.every((m) => m.threadId === null)).toBe(true);
  const after = await win(db, { threadId: 7, after: new Date(Date.UTC(2026, 0, 1, 0, 0, 25)) });
  expect(after.map((m) => m.seq)).toEqual([26, 28, 30]);
});

test("recentMessages, lastBotMessageAt, getMessage, updateMessageText", async () => {
  const db = await fill(5, (i) => ({ isBot: i === 3 }));
  expect((await recentMessages(db, 1, 2)).map((m) => m.messageId)).toEqual([4, 5]);
  expect((await lastBotMessageAt(db, 1))?.toISOString()).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString());
  expect(await updateMessageText(db, 1, 2, "edited", [{ type: "bold" }])).toBe(true);
  expect(await updateMessageText(db, 1, 99, "nope", null)).toBe(false);
  const m = await getMessage(db, 1, 2);
  expect(m?.text).toBe("edited");
  expect(m?.entities).toEqual([{ type: "bold" }]);
  expect(await getMessage(db, 1, 99)).toBeNull();
});

test("deleteChatMessages returns file ids and empties the chat", async () => {
  const db = await fill(3);
  await setAnthropicFileId(db, 1, 2, "f2");
  expect(await deleteChatMessages(db, 1)).toEqual(["f2"]);
  expect(await recentMessages(db, 1, 10)).toEqual([]);
});
