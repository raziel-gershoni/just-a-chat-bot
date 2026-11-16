import { describe, expect, it } from "vitest";
import { postCards } from "@/src/bakery/cards";
import { fakeBakery } from "../helpers/fake-bakery";
import { fakeTg } from "../helpers/fake-tg";

const base = { chatId: -100, threadId: 7, replyTo: 55, already: [] as number[] };

describe("postCards", () => {
  it("posts the bakery's summaryHe with approve/reject buttons", async () => {
    const tg = fakeTg(), bakery = fakeBakery();
    bakery.proposals.set(12, "הסיכום מהמאפייה");
    const ids = await postCards({ tg, bakery, lang: "he" }, { ...base, proposals: [{ proposalId: 12, summary: "fallback" }] });
    expect(ids).toEqual([12]);
    const [chat, text, params] = tg.calls[0]!.args as [number, string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] }; message_thread_id: number }];
    expect(chat).toBe(-100);
    expect(text).toBe("הסיכום מהמאפייה");
    expect(params.message_thread_id).toBe(7);
    const row = params.reply_markup.inline_keyboard[0]!;
    expect(row.map(b => b.callback_data)).toEqual(["mcp:approve:12", "mcp:reject:12"]);
    expect(Buffer.byteLength(row[0]!.callback_data)).toBeLessThanOrEqual(64);
  });
  it("falls back to the propose-result summary", async () => {
    const tg = fakeTg();
    await postCards({ tg, bakery: fakeBakery(), lang: "he" }, { ...base, proposals: [{ proposalId: 12, summary: "fallback" }] });
    expect(tg.calls[0]!.args[1]).toBe("fallback");
  });
  it("posts nothing when there is no summary at all", async () => {
    const tg = fakeTg();
    expect(await postCards({ tg, bakery: fakeBakery(), lang: "he" }, { ...base, proposals: [{ proposalId: 12, summary: null }] })).toEqual([]);
    expect(tg.calls).toHaveLength(0);
  });
  it("skips proposals already posted", async () => {
    const tg = fakeTg();
    const ids = await postCards({ tg, bakery: fakeBakery(), lang: "he" }, { ...base, already: [12], proposals: [{ proposalId: 12, summary: "x" }] });
    expect(ids).toEqual([]);
    expect(tg.calls).toHaveLength(0);
  });
  it("reports each card as it is posted, so a later failure keeps the earlier ones", async () => {
    const tg = fakeTg();
    const orig = tg.sendMessage;
    let n = 0;
    tg.sendMessage = (async (...a: Parameters<typeof orig>) => { if (++n === 2) throw new Error("tg down"); return orig(...a); }) as typeof orig;
    const persisted: number[] = [];
    await expect(postCards({ tg, bakery: fakeBakery(), lang: "he" },
      { ...base, proposals: [{ proposalId: 1, summary: "a" }, { proposalId: 2, summary: "b" }] }, id => { persisted.push(id); })).rejects.toThrow("tg down");
    expect(persisted).toEqual([1]);
  });
});
