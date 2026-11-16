import { describe, expect, it } from "vitest";
import { escapeMd2, sendAnswer, sendText, sourcesBlock } from "@/src/telegram/send";
import { fakeTg } from "@/tests/helpers/fake-tg";

type Sent = { chat: number; text: string; extra: Record<string, any> };
const sent = (tg: ReturnType<typeof fakeTg>): Sent[] =>
  tg.calls.filter(c => c.method === "sendMessage").map(c => ({ chat: c.args[0] as number, text: c.args[1] as string, extra: (c.args[2] ?? {}) as Record<string, any> }));

describe("sendAnswer", () => {
  it("splits 5000 chars into 2 messages; reply only on the first, thread on both", async () => {
    const tg = fakeTg();
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ${"word ".repeat(18)}`.trim()).join("\n\n");
    expect(text.length).toBeGreaterThan(4800);
    const ids = await sendAnswer(tg, -100, text, { replyTo: 42, threadId: 7 });
    const msgs = sent(tg);
    expect(msgs).toHaveLength(2);
    expect(ids).toEqual([1000, 1001]);
    expect(msgs[0]!.extra.reply_parameters).toEqual({ message_id: 42, allow_sending_without_reply: true });
    expect(msgs[1]!.extra.reply_parameters).toBeUndefined();
    expect(msgs.map(m => m.extra.message_thread_id)).toEqual([7, 7]);
    for (const m of msgs) expect(m.text.length).toBeLessThanOrEqual(4096);
  });

  it("appends tailMd2 to the last part when it fits", async () => {
    const tg = fakeTg();
    await sendAnswer(tg, -100, "Short answer", { tailMd2: "\\(tail\\)" });
    const msgs = sent(tg);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text.endsWith("\\(tail\\)")).toBe(true);
    expect(msgs[0]!.extra.parse_mode).toBe("MarkdownV2");
  });

  it("sends the tail as its own message when it would exceed 4096", async () => {
    const tg = fakeTg();
    const body = "x".repeat(3400);
    await sendAnswer(tg, -100, body, { tailMd2: "y".repeat(900) });
    const msgs = sent(tg);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toBe("y".repeat(900));
    expect(msgs[1]!.extra.parse_mode).toBe("MarkdownV2");
  });

  it("falls back to plain text when the formatted send fails, keeping the tail", async () => {
    const tg = fakeTg();
    const real = tg.sendMessage;
    let n = 0;
    tg.sendMessage = (async (...a: Parameters<typeof real>) => {
      if (n++ === 0) throw new Error("can't parse entities");
      return real(...a);
    }) as typeof real;
    const ids = await sendAnswer(tg, -100, "hello", { tailMd2: "tail" });
    const msgs = sent(tg);
    expect(msgs[0]!.text).toBe("hello");
    expect(msgs[0]!.extra.parse_mode).toBeUndefined();
    expect(msgs[1]!.text).toBe("tail");
    expect(ids).toHaveLength(2);
  });

  it("throws a 429 without a plain retry", async () => {
    const tg = fakeTg();
    tg.sendMessage = (async () => { throw Object.assign(new Error("slow down"), { error_code: 429 }); }) as typeof tg.sendMessage;
    await expect(sendAnswer(tg, -100, "hi", {})).rejects.toThrow("slow down");
  });
});

describe("sendText", () => {
  it("sends plain text with buttons, no parse mode, previews off", async () => {
    const tg = fakeTg();
    const id = await sendText(tg, -100, "Approve?", {
      replyTo: 5, threadId: 3,
      buttons: [[{ text: "Yes", data: "ok:1" }, { text: "Open", url: "https://t.me/x" }]],
    });
    expect(id).toBe(1000);
    const m = sent(tg)[0]!;
    expect(m.extra.parse_mode).toBeUndefined();
    expect(m.extra.link_preview_options).toEqual({ is_disabled: true });
    expect(m.extra.message_thread_id).toBe(3);
    expect(m.extra.reply_markup.inline_keyboard).toEqual([[
      { text: "Yes", callback_data: "ok:1" }, { text: "Open", url: "https://t.me/x" },
    ]]);
  });
});

describe("escapeMd2 / sourcesBlock", () => {
  it("escapes reserved characters", () => {
    expect(escapeMd2("a.b!")).toBe("a\\.b\\!");
    expect(escapeMd2("a_b (c)")).toBe("a\\_b \\(c\\)");
  });

  it("builds an expandable quote with escaped titles", () => {
    const out = sourcesBlock("Sources", [{ url: "https://a.com/x_y", title: "A (b)" }]);
    expect(out.startsWith("**>Sources")).toBe(true);
    expect(out).toContain(">[A \\(b\\)](https://a.com/x_y)");
    expect(out.endsWith("||")).toBe(true);
    expect(sourcesBlock("S", [{ url: "https://a.com", title: "a_b" }])).toContain("[a\\_b]");
  });

  it("caps at 5, falls back to hostname, and is empty for none", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.com/p`, title: null }));
    const out = sourcesBlock("S", many);
    expect(out.split("\n")).toHaveLength(6);
    expect(out).toContain("[s0\\.com](https://s0.com/p)");
    expect(sourcesBlock("S", [])).toBe("");
  });
});
