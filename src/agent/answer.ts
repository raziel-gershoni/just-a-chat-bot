import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const RESULT_TYPES = new Set(["web_search_tool_result", "web_fetch_tool_result", "mcp_tool_result"]);

// The text of the final turn: what follows the last tool result. Text before it is narration
// ("let me check") that should not be posted.
function answerBlocks(blocks: BetaContentBlock[]): Extract<BetaContentBlock, { type: "text" }>[] {
  let last = -1;
  blocks.forEach((b, i) => {
    if (RESULT_TYPES.has(b.type)) last = i;
  });
  const texts = (from: number) => blocks.slice(from).filter((b): b is Extract<BetaContentBlock, { type: "text" }> => b.type === "text");
  const after = texts(last + 1);
  return after.length > 0 || last < 0 ? after : texts(0);
}

export function answerText(blocks: BetaContentBlock[]): string {
  return answerBlocks(blocks).map((b) => b.text).join("").trim();
}

export function answerSources(blocks: BetaContentBlock[]): { url: string; title: string }[] {
  const seen = new Set<string>();
  const out: { url: string; title: string }[] = [];
  for (const b of answerBlocks(blocks)) {
    for (const c of b.citations ?? []) {
      if (c.type !== "web_search_result_location" || seen.has(c.url)) continue;
      seen.add(c.url);
      out.push({ url: c.url, title: c.title ?? c.url });
    }
  }
  return out;
}

// Every content block the assistant produced in this run, from the run's first assistant message.
export function runBlocks(messages: unknown[], fromIndex: number): BetaContentBlock[] {
  const out: BetaContentBlock[] = [];
  for (const m of messages.slice(fromIndex) as { role?: string; content?: unknown }[]) {
    if (m?.role === "assistant" && Array.isArray(m.content)) out.push(...(m.content as BetaContentBlock[]));
  }
  return out;
}
