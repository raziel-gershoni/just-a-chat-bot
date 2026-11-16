import type { CallbackQuery } from "grammy/types";
import { describe, expect, it } from "vitest";
import { handleBakeryCallback, truncate200 } from "@/src/bakery/callback";
import type { DecisionResult } from "@/src/bakery/api";
import { t } from "@/src/i18n";
import { fakeBakery } from "../helpers/fake-bakery";
import { fakeTg } from "../helpers/fake-tg";

const query = (data: string) => ({
  id: "cb1", from: { id: 4242 }, data,
  message: { message_id: 90, chat: { id: -100 }, message_thread_id: 7 },
}) as unknown as CallbackQuery;
const lang = async () => "he" as const;
const methods = (tg: ReturnType<typeof fakeTg>) => tg.calls.map(c => c.method);

describe("handleBakeryCallback", () => {
  it.each(["applied", "rejected", "not_found", "already_decided", "expired", "stale", "failed"])(
    "%s: answers, removes buttons and replies", async outcome => {
      const tg = fakeTg();
      const bakery = fakeBakery({ status: outcome === "failed" ? 500 : 200, outcome, message: "הודעה" });
      expect(await handleBakeryCallback(query("mcp:approve:12"), { tg, bakery, lang })).toBe(true);
      expect(bakery.decideCalls).toEqual([{ id: 12, telegramUserId: 4242, decision: "approve" }]);
      expect(tg.calls[0]).toEqual({ method: "answerCallbackQuery", args: ["cb1", { text: "הודעה", show_alert: false }] });
      expect(tg.calls[1]).toEqual({ method: "editMessageReplyMarkup", args: [-100, 90] });
      expect(tg.calls[2]!.method).toBe("sendMessage");
      expect(tg.calls[2]!.args[1]).toBe("הודעה");
      const params = tg.calls[2]!.args[2] as { reply_parameters: { message_id: number }; message_thread_id: number };
      expect(params.reply_parameters.message_id).toBe(90);
      expect(params.message_thread_id).toBe(7);
    });

  it("reject maps to decision reject", async () => {
    const bakery = fakeBakery({ status: 200, outcome: "rejected", message: "m" });
    await handleBakeryCallback(query("mcp:reject:3"), { tg: fakeTg(), bakery, lang });
    expect(bakery.decideCalls[0]).toEqual({ id: 3, telegramUserId: 4242, decision: "reject" });
  });

  it("not_owner: alert, buttons kept, no reply", async () => {
    const tg = fakeTg();
    await handleBakeryCallback(query("mcp:approve:12"), { tg, bakery: fakeBakery({ status: 403, outcome: "not_owner", message: "רק הבעלים" }), lang });
    expect(tg.calls).toEqual([{ method: "answerCallbackQuery", args: ["cb1", { text: "רק הבעלים", show_alert: true }] }]);
  });

  it.each<[string, DecisionResult]>([
    ["401 without outcome", { status: 401 }],
    ["network error", { status: 0 }],
    ["401 that carries an outcome body", { status: 401, outcome: "failed", message: "unauthorized" }],
  ])(
    "%s: unreachable alert, buttons kept", async (_n, res) => {
      const tg = fakeTg();
      await handleBakeryCallback(query("mcp:approve:12"), { tg, bakery: fakeBakery(res), lang });
      expect(tg.calls).toEqual([{ method: "answerCallbackQuery", args: ["cb1", { text: t("he", "bakeryUnreachable"), show_alert: true }] }]);
    });

  it("bakery not configured: unreachable alert", async () => {
    const tg = fakeTg();
    await handleBakeryCallback(query("mcp:approve:12"), { tg, bakery: null, lang });
    expect(methods(tg)).toEqual(["answerCallbackQuery"]);
    expect((tg.calls[0]!.args[1] as { show_alert: boolean }).show_alert).toBe(true);
  });

  it("truncates a long Hebrew answer but replies in full", async () => {
    const tg = fakeTg();
    const message = "א".repeat(300);
    await handleBakeryCallback(query("mcp:approve:12"), { tg, bakery: fakeBakery({ status: 200, outcome: "applied", message }), lang });
    const text = (tg.calls[0]!.args[1] as { text: string }).text;
    expect(Array.from(text).length).toBeLessThanOrEqual(200);
    expect(text.endsWith("…")).toBe(true);
    expect(tg.calls[2]!.args[1]).toBe(message);
  });

  it("an edit or send failure after answering is logged, not thrown", async () => {
    const tg = fakeTg();
    tg.editMessageReplyMarkup = (async () => { throw new Error("gone"); }) as typeof tg.editMessageReplyMarkup;
    tg.sendMessage = (async () => { throw new Error("gone"); }) as typeof tg.sendMessage;
    await expect(handleBakeryCallback(query("mcp:approve:12"), { tg, bakery: fakeBakery(), lang })).resolves.toBe(true);
  });

  it("returns false for other data", async () => {
    const tg = fakeTg();
    expect(await handleBakeryCallback(query("other"), { tg, bakery: fakeBakery(), lang })).toBe(false);
    expect(tg.calls).toHaveLength(0);
  });
});

describe("truncate200", () => {
  it("keeps short text and cuts on code points", () => {
    expect(truncate200("abc")).toBe("abc");
    const cut = truncate200("😀".repeat(250));
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.isWellFormed()).toBe(true);
  });
});
