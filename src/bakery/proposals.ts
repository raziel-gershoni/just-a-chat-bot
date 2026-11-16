import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { errorText } from "../util/errors";
import { log } from "../util/log";

export type ExtractedProposal = { proposalId: number; summary: string | null };

// Proposals the bakery's propose_* tools created in these assistant blocks: successful
// results only, matched to their tool_use by id. Never throws; an unparseable result is
// logged and skipped.
export function extractProposals(blocks: BetaContentBlock[]): ExtractedProposal[] {
  const proposeUses = new Set<string>();
  for (const b of blocks) {
    if (b.type === "mcp_tool_use" && b.server_name === "bakery" && b.name.startsWith("propose_")) proposeUses.add(b.id);
  }
  const out: ExtractedProposal[] = [];
  for (const b of blocks) {
    if (b.type !== "mcp_tool_result" || b.is_error || !proposeUses.has(b.tool_use_id)) continue;
    const text = typeof b.content === "string"
      ? b.content
      : b.content.map(c => (c.type === "text" ? c.text : "")).join("");
    try {
      const parsed: unknown = JSON.parse(text);
      const id = typeof parsed === "object" && parsed !== null ? (parsed as { proposalId?: unknown }).proposalId : undefined;
      if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("no numeric proposalId");
      const summary = (parsed as { summary?: unknown }).summary;
      out.push({ proposalId: id, summary: typeof summary === "string" && summary.trim() ? summary : null });
    } catch (err) {
      log("bakery.proposal_parse_failed", { tool_use_id: b.tool_use_id, error: errorText(err) });
    }
  }
  return out;
}
