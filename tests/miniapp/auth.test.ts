import { createHmac } from "node:crypto";
import { GrammyError } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/src/miniapp/auth";
import { signSession, verifySession } from "@/src/miniapp/jwt";
import { upsertGroup } from "@/src/db/repo/groups";
import { testDb } from "@/tests/helpers/db";
import { fakeTg } from "@/tests/helpers/fake-tg";
import { fakeLlm } from "@/tests/helpers/fake-llm";
import type { MiniDeps } from "@/src/miniapp/service";

const TOKEN = "123:abc";
const SECRET = "s".repeat(40);
const NOW = new Date("2026-11-16T12:00:00Z");
const OWNER = 7;

function sign(userId: number, startParam: string | null, lang = "he", extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(NOW.getTime() / 1000) - 10),
    user: JSON.stringify({ id: userId, first_name: "D", language_code: lang }),
    ...(startParam ? { start_param: startParam } : {}),
    ...extra,
  };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", key).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

let deps: MiniDeps;
let tg: ReturnType<typeof fakeTg>;
beforeEach(async () => {
  const db = await testDb();
  await upsertGroup(db, { chatId: -100, title: "Fam", settings: {}, token: "tok_a" });
  await upsertGroup(db, { chatId: -200, title: "Off", settings: {}, token: "tok_off" });
  tg = fakeTg();
  tg.members.set(10, "member");
  tg.members.set(11, "left");
  tg.members.set(OWNER, "administrator");
  const { setGroupActive } = await import("@/src/db/repo/groups");
  await setGroupActive(db, -200, false);
  deps = {
    db, tg, llm: fakeLlm(), now: () => NOW,
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_OWNER_ID: OWNER, JWT_SECRET: SECRET },
  };
});

describe("jwt", () => {
  it("round-trips claims and rejects a wrong secret or garbage", async () => {
    const claims = { userId: 1, chatId: -5, owner: true, lang: "he" as const };
    const tok = await signSession(claims, SECRET);
    expect(await verifySession(tok, SECRET)).toMatchObject(claims);
    expect(await verifySession(tok, "x".repeat(40))).toBeNull();
    expect(await verifySession("nope", SECRET)).toBeNull();
  });
});

describe("createSession", () => {
  it("issues a token carrying the chat id for a member", async () => {
    const r = await createSession(deps, sign(10, "tok_a"));
    if ("error" in r) throw new Error(r.error);
    expect(await verifySession(r.token, SECRET)).toMatchObject({ userId: 10, chatId: -100, owner: false, lang: "he" });
  });
  it("marks the owner", async () => {
    const r = await createSession(deps, sign(OWNER, "tok_a", "en"));
    if ("error" in r) throw new Error(r.error);
    expect(await verifySession(r.token, SECRET)).toMatchObject({ owner: true, lang: "en" });
  });
  it("invalid initData -> invalid (401)", async () => {
    expect(await createSession(deps, "garbage")).toEqual({ error: "invalid", status: 401 });
  });
  it("wrong or inactive start_param -> unknown_group (404)", async () => {
    expect(await createSession(deps, sign(10, "nope"))).toEqual({ error: "unknown_group", status: 404 });
    expect(await createSession(deps, sign(10, null))).toEqual({ error: "unknown_group", status: 404 });
    expect(await createSession(deps, sign(10, "tok_off"))).toEqual({ error: "unknown_group", status: 404 });
  });
  it("logs why the group is unknown and which kind of chat the app was opened from", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createSession(deps, sign(10, null));
      await createSession(deps, sign(10, "nope", "he", { chat_type: "group" }));
      await createSession(deps, sign(10, "tok_off"));
      const lines = spy.mock.calls
        .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
        .filter((l) => l.event === "miniapp.session_unknown_group");
      expect(lines.map((l) => [l.reason, l.chat_type])).toEqual([
        ["no_start_param", null], ["no_group", "group"], ["inactive", null],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
  it("a user who left -> not_member (403)", async () => {
    expect(await createSession(deps, sign(11, "tok_a"))).toEqual({ error: "not_member", status: 403 });
  });
  it("a definite refusal of the membership check (400 user not found) -> not_member (403)", async () => {
    tg.getChatMember = async () => { throw new GrammyError("x", { ok: false, error_code: 400, description: "Bad Request: user not found" }, "getChatMember", {}); };
    expect(await createSession(deps, sign(10, "tok_a"))).toEqual({ error: "not_member", status: 403 });
  });
  it("a transient membership-check failure (network, 429, 5xx) -> unavailable (502), never a session", async () => {
    for (const err of [
      new Error("socket hang up"),
      new GrammyError("x", { ok: false, error_code: 429, description: "Too Many Requests" }, "getChatMember", {}),
      new GrammyError("x", { ok: false, error_code: 500, description: "Internal Server Error" }, "getChatMember", {}),
    ]) {
      tg.getChatMember = async () => { throw err; };
      expect(await createSession(deps, sign(10, "tok_a"))).toEqual({ error: "unavailable", status: 502 });
    }
  });
});
