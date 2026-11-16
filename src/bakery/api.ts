// The bakery's REST endpoints for proposals (cards and decisions). The key is read from the
// config handed in at call time and goes only into the Authorization header.
import { errorText } from "../util/errors";
import { log } from "../util/log";

export type DecisionResult = { status: number; outcome?: string; message?: string };

export type BakeryApi = {
  getProposal(id: number): Promise<{ summaryHe: string } | null>;
  decide(id: number, telegramUserId: number, decision: "approve" | "reject"): Promise<DecisionResult>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function bakeryApi(cfg: { url: string; key: string }, fetchImpl: typeof fetch = fetch): BakeryApi {
  const base = cfg.url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" };

  return {
    async getProposal(id) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/api/mcp/proposals/${id}`, { method: "GET", headers });
      } catch (err) {
        log("bakery.proposal_fetch_failed", { id, status: 0, error: errorText(err) });
        return null;
      }
      if (res.status !== 200) {
        log("bakery.proposal_fetch_failed", { id, status: res.status });
        return null;
      }
      try {
        const body: unknown = await res.json();
        const proposal = isRecord(body) ? body.proposal : undefined;
        const summary = isRecord(proposal) ? proposal.summaryHe : undefined;
        if (typeof summary === "string" && summary.trim()) return { summaryHe: summary };
        log("bakery.proposal_fetch_failed", { id, status: 200, error: "no summaryHe in body" });
      } catch (err) {
        log("bakery.proposal_fetch_failed", { id, status: 200, error: errorText(err) });
      }
      return null;
    },

    async decide(id, telegramUserId, decision) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/api/mcp/proposals/${id}/decision`, {
          method: "POST",
          headers,
          body: JSON.stringify({ telegramUserId, decision }),
        });
      } catch (err) {
        log("bakery.decision_request_failed", { id, error: errorText(err) });
        return { status: 0 };
      }
      try {
        const body: unknown = await res.json();
        if (!isRecord(body)) return { status: res.status };
        return {
          status: res.status,
          ...(typeof body.outcome === "string" ? { outcome: body.outcome } : {}),
          ...(typeof body.message === "string" ? { message: body.message } : {}),
        };
      } catch (err) {
        log("bakery.decision_body_unparseable", { id, status: res.status, error: errorText(err) });
        return { status: res.status };
      }
    },
  };
}
