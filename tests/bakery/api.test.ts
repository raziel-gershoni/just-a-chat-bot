import { describe, expect, it, vi } from "vitest";
import { bakeryApi } from "@/src/bakery/api";

const cfg = { url: "https://bakery.test/", key: "bmcp_secret" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("bakeryApi", () => {
  it("getProposal sends the bearer key and returns summaryHe", async () => {
    const f = vi.fn(async () => json(200, { proposal: { id: 12, summaryHe: "שינוי" } }));
    const r = await bakeryApi(cfg, f as unknown as typeof fetch).getProposal(12);
    expect(r).toEqual({ summaryHe: "שינוי" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bakery.test/api/mcp/proposals/12");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer bmcp_secret");
  });

  it("getProposal returns null on non-200 and on network error", async () => {
    expect(await bakeryApi(cfg, (async () => json(404, {})) as typeof fetch).getProposal(1)).toBeNull();
    expect(await bakeryApi(cfg, (async () => { throw new Error("down"); }) as typeof fetch).getProposal(1)).toBeNull();
  });

  it("decide posts telegramUserId and decision and parses the body", async () => {
    const f = vi.fn(async () => json(403, { outcome: "not_owner", message: "לא" }));
    const r = await bakeryApi(cfg, f as unknown as typeof fetch).decide(5, 77, "approve");
    expect(r).toEqual({ status: 403, outcome: "not_owner", message: "לא" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://bakery.test/api/mcp/proposals/5/decision");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ telegramUserId: 77, decision: "approve" });
  });

  it("decide returns status 0 on a network error and just the status on a bad body", async () => {
    expect(await bakeryApi(cfg, (async () => { throw new Error("down"); }) as typeof fetch).decide(1, 2, "reject")).toEqual({ status: 0 });
    expect(await bakeryApi(cfg, (async () => new Response("<html>", { status: 502 })) as typeof fetch).decide(1, 2, "reject")).toEqual({ status: 502 });
  });
});
