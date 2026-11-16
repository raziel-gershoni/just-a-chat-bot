import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { chimeTranscript, classifyChime } from "@/src/chime/classifier";
import type { StoredMessage } from "@/src/db/repo/messages";
import { fakeLlm } from "../helpers/fake-llm";

const reply = (text: string): BetaMessage =>
  ({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", content: [{ type: "text", text }] }) as unknown as BetaMessage;

let logSpy: MockInstance;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const input = { transcript: "[10:00] A: hi", eagerness: "low" as const, bakery: false };
const sys = (p: { system?: unknown }) => String(p.system);

describe("classifyChime", () => {
  it("sends haiku params with low effort, json schema and no fallbacks", async () => {
    const llm = fakeLlm([], { classify: [reply('{"chime":true,"reason":"unanswered question"}')] });
    const r = await classifyChime({ llm }, input);
    expect(r).toEqual({ chime: true, reason: "unanswered question" });
    const p = llm.classifyCalls[0] as Record<string, any>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.max_tokens).toBe(400);
    expect(p.output_config.effort).toBe("low");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.output_config.format.schema.additionalProperties).toBe(false);
    expect("fallbacks" in p).toBe(false);
    expect(p.betas ?? []).not.toContain("server-side-fallback-2026-07-01");
    expect(JSON.stringify(p.messages)).toContain("[10:00] A: hi");
  });

  it("mentions bakery only when enabled", async () => {
    const a = fakeLlm([], { classify: [reply('{"chime":false,"reason":"x"}')] });
    await classifyChime({ llm: a }, { ...input, bakery: true });
    expect(sys(a.classifyCalls[0]!)).toContain("bakery");
    const b = fakeLlm([], { classify: [reply('{"chime":false,"reason":"x"}')] });
    await classifyChime({ llm: b }, input);
    expect(sys(b.classifyCalls[0]!)).not.toContain("bakery");
  });

  it("changes the eagerness sentence", async () => {
    const a = fakeLlm([], { classify: [reply('{"chime":false,"reason":"x"}'), reply('{"chime":false,"reason":"x"}')] });
    await classifyChime({ llm: a }, input);
    await classifyChime({ llm: a }, { ...input, eagerness: "high" });
    expect(sys(a.classifyCalls[0]!)).not.toBe(sys(a.classifyCalls[1]!));
  });

  it("retries once on invalid output", async () => {
    const llm = fakeLlm([], { classify: [reply("nope"), reply('{"chime":false,"reason":"banter"}')] });
    expect(await classifyChime({ llm }, input)).toEqual({ chime: false, reason: "banter" });
    expect(llm.classifyCalls).toHaveLength(2);
  });

  it("returns null and logs after two invalid outputs", async () => {
    const llm = fakeLlm([], { classify: [reply("nope"), reply('{"chime":"yes"}')] });
    expect(await classifyChime({ llm }, input)).toBeNull();
    expect(llm.classifyCalls).toHaveLength(2);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("chime.classify_invalid"))).toBe(true);
  });

  it("treats a thrown LLM error as an invalid attempt, logged", async () => {
    const llm = fakeLlm([], { classify: [new Error("boom"), new Error("boom")] });
    expect(await classifyChime({ llm }, input)).toBeNull();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes("boom"))).toBe(true);
  });
});

describe("chimeTranscript", () => {
  const row = (o: Partial<StoredMessage>): StoredMessage =>
    ({ chatId: 1, messageId: 1, seq: 1, fromName: "Dana", isBot: false, date: new Date("2026-01-01T08:05:00Z"), text: "hello", media: null, ...o }) as StoredMessage;
  it("formats Israel time, bot rows and media labels", () => {
    const t = chimeTranscript([
      row({}),
      row({ isBot: true, fromName: "Whatever", text: "hi" }),
      row({ text: "look", media: { kind: "photo", label: "photo" } }),
    ]);
    expect(t).toBe("[10:05] Dana: hello\n[10:05] Bot: hi\n[10:05] Dana: look [photo]");
  });
  it("shows a tag of a member without a username as @Name", () => {
    const entities = [{ type: "text_mention", offset: 0, length: 3, user: { id: 7, is_bot: false, first_name: "Avi" } }];
    expect(chimeTranscript([row({ text: "Avi look", entities })])).toBe("[10:05] Dana: @Avi look");
  });
});
