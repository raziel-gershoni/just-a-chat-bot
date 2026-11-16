import type { BakeryApi, DecisionResult } from "@/src/bakery/api";

export type FakeBakery = BakeryApi & {
  decideCalls: { id: number; telegramUserId: number; decision: string }[];
  proposals: Map<number, string>;
};

// A hand-written bakery: proposals come from `proposals` (id -> summaryHe, missing = null),
// decide() returns `decision` for every call.
export function fakeBakery(decision: DecisionResult = { status: 200, outcome: "applied", message: "ok" }): FakeBakery {
  const decideCalls: FakeBakery["decideCalls"] = [];
  const proposals = new Map<number, string>();
  return {
    decideCalls,
    proposals,
    getProposal: async id => (proposals.has(id) ? { summaryHe: proposals.get(id)! } : null),
    decide: async (id, telegramUserId, d) => { decideCalls.push({ id, telegramUserId, decision: d }); return decision; },
  };
}
