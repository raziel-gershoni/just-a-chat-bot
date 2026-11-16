import { describe, expect, test } from "vitest";
import { answerSources, answerText, runBlocks } from "@/src/agent/answer";

const text = (t: string, citations?: unknown[]) => ({ type: "text", text: t, ...(citations ? { citations } : {}) }) as any;
const cite = (url: string, title = url) => ({ type: "web_search_result_location", url, title, cited_text: "", encrypted_index: "" });

describe("answerText", () => {
  test("takes only text after the last tool result", () => {
    const blocks = [
      text("Let me check"),
      { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      text("It is 5°"),
    ] as any[];
    expect(answerText(blocks)).toBe("It is 5°");
  });
  test("plain text and joining", () => {
    expect(answerText([text("Hi")])).toBe("Hi");
    expect(answerText([text(" a"), text("b ")])).toBe("ab");
  });
  test("falls back to all text when nothing follows the last result", () => {
    const blocks = [text("Before"), { type: "mcp_tool_result", tool_use_id: "m", content: "x" }] as any[];
    expect(answerText(blocks)).toBe("Before");
  });
  test("mcp and web_fetch results also cut", () => {
    const blocks = [text("a"), { type: "web_fetch_tool_result" }, text("b"), { type: "mcp_tool_result" }, text("c")] as any[];
    expect(answerText(blocks)).toBe("c");
  });
  test("no text gives empty string", () => {
    expect(answerText([{ type: "thinking" }] as any[])).toBe("");
  });
});

describe("answerSources", () => {
  test("dedupes by url, keeps order, ignores earlier text", () => {
    const blocks = [
      text("old", [cite("https://old")]),
      { type: "web_search_tool_result" },
      text("a", [cite("https://a", "A"), cite("https://b", "B")]),
      text("b", [cite("https://a", "A again"), { type: "char_location", url: "x" }]),
    ] as any[];
    expect(answerSources(blocks)).toEqual([
      { url: "https://a", title: "A" },
      { url: "https://b", title: "B" },
    ]);
  });
});

describe("runBlocks", () => {
  test("flattens assistant content from the index", () => {
    const msgs = [
      { role: "assistant", content: [text("old")] },
      { role: "user", content: "u" },
      { role: "assistant", content: [text("a"), text("b")] },
      { role: "assistant", content: [text("c")] },
    ];
    expect(runBlocks(msgs, 1).map((b: any) => b.text)).toEqual(["a", "b", "c"]);
    expect(runBlocks(msgs, 0)).toHaveLength(4);
  });
  test("string content is skipped", () => {
    expect(runBlocks([{ role: "assistant", content: "plain" }], 0)).toEqual([]);
  });
});
