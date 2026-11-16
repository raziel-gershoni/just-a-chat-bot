import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { extractProposals } from "@/src/bakery/proposals";

const use = (id: string, name: string, server = "bakery") =>
  ({ type: "mcp_tool_use", id, name, server_name: server, input: {} }) as unknown as BetaContentBlock;
const result = (id: string, content: unknown, is_error = false) =>
  ({ type: "mcp_tool_result", tool_use_id: id, is_error, content }) as unknown as BetaContentBlock;
const payload = '{"proposalId":12,"status":"pending","summary":"שינוי","expiresAt":"x"}';

describe("extractProposals", () => {
  it("extracts a propose_ result", () => {
    expect(extractProposals([use("u1", "propose_bread_price"), result("u1", payload)]))
      .toEqual([{ proposalId: 12, summary: "שינוי" }]);
  });
  it("ignores error results", () => {
    expect(extractProposals([use("u1", "propose_bread_price"), result("u1", payload, true)])).toEqual([]);
  });
  it("ignores non-propose tools and other servers", () => {
    expect(extractProposals([use("u1", "get_sales"), result("u1", payload)])).toEqual([]);
    expect(extractProposals([use("u1", "propose_deal", "other"), result("u1", payload)])).toEqual([]);
  });
  it("reads text-block content", () => {
    expect(extractProposals([use("u1", "propose_deal"), result("u1", [{ type: "text", text: '{"proposalId":3}' }])]))
      .toEqual([{ proposalId: 3, summary: null }]);
  });
  it("skips unparseable results", () => {
    expect(extractProposals([use("u1", "propose_deal"), result("u1", "not json"), use("u2", "propose_deal"), result("u2", '{"proposalId":"x"}')])).toEqual([]);
  });
});
