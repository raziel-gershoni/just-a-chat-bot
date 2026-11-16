import { describe, expect, test } from "vitest";
import { buildParams, newSnapshot } from "@/src/agent/request";
import { BAKERY_LINE, SYSTEM_BASE, contextMessage, systemPrompt } from "@/src/agent/prompts";
import { BAKERY_READ_TOOLS, bakeryConfig } from "@/src/bakery/config";
import { defaultSettings } from "@/src/settings/schema";
import type { RunSnapshot, RunTrigger } from "@/src/db/schema";

const cfg = { url: "https://b.example", key: "bmcp_secret123" };
const opus = { id: "claude-opus-5-5", displayName: "Opus", maxTokens: 64000, efforts: ["low", "medium"], adaptive: true };
const settings = { ...defaultSettings("en"), bakery: true };

function snap(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    ...newSnapshot({ settings, model: opus, bakeryAvailable: true, chime: false, transcript: [{ role: "user", content: "hi" }], context: "ctx" }),
    ...over,
  };
}

describe("buildParams", () => {
  test("full bakery: toolset without default_config, server url, MCP beta", () => {
    const p = buildParams(snap({ bakery: "full" }), cfg) as any;
    const ts = p.tools.find((t: any) => t.type === "mcp_toolset");
    expect(ts).toEqual({ type: "mcp_toolset", mcp_server_name: "bakery" });
    expect(p.mcp_servers).toEqual([
      { type: "url", name: "bakery", url: "https://b.example/api/mcp", authorization_token: "bmcp_secret123" },
    ]);
    expect(p.betas).toContain("mcp-client-2026-09-15");
  });

  test("read bakery: only read tools enabled, no propose_*", () => {
    const p = buildParams(snap({ bakery: "read" }), cfg) as any;
    const ts = p.tools.find((t: any) => t.type === "mcp_toolset");
    expect(ts.default_config.enabled).toBe(false);
    expect(ts.configs.get_sales.enabled).toBe(true);
    expect(Object.keys(ts.configs)).toEqual([...BAKERY_READ_TOOLS]);
    expect(Object.keys(ts.configs).some((k) => k.startsWith("propose_"))).toBe(false);
  });

  test("no bakery config, or bakeryDropped: no MCP at all", () => {
    for (const p of [buildParams(snap({ bakery: "full" }), null), buildParams(snap({ bakery: "full", bakeryDropped: true }), cfg)] as any[]) {
      expect(p.mcp_servers).toBeUndefined();
      expect(p.tools.some((t: any) => t.type === "mcp_toolset")).toBe(false);
      expect(p.betas ?? []).not.toContain("mcp-client-2026-09-15");
    }
  });

  test("base shape: web tools, cached system, effort, adaptive thinking", () => {
    const p = buildParams(snap({ bakery: null }), cfg) as any;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(32000);
    expect(p.system).toEqual([{ type: "text", text: expect.any(String), cache_control: { type: "ephemeral" } }]);
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.tools).toEqual([
      { type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
      { type: "web_fetch_20260318", name: "web_fetch", allowed_callers: ["direct"] },
    ]);
  });

  test("thinking omitted when off; fallbacks beta only when enabled", () => {
    const off = buildParams(snap({ thinking: false, fallbacks: false, bakery: null }), cfg) as any;
    expect(off.thinking).toBeUndefined();
    expect(off.fallbacks).toBeUndefined();
    expect(off.betas ?? []).not.toContain("server-side-fallback-2026-07-01");
    const on = buildParams(snap({ fallbacks: true, bakery: null }), cfg) as any;
    expect(on.fallbacks).toBe("default");
    expect(on.betas).toContain("server-side-fallback-2026-07-01");
  });

  test("output is byte-stable and the snapshot never holds the key", () => {
    const s = snap({ bakery: "full" });
    expect(JSON.stringify(buildParams(s, cfg))).toBe(JSON.stringify(buildParams(s, cfg)));
    expect(JSON.stringify(s)).not.toContain("bmcp_");
  });
});

describe("newSnapshot", () => {
  const base = { settings, bakeryAvailable: true, chime: false, transcript: [{ role: "user", content: "hi" }], context: "ctx" };
  test("haiku has no fallbacks", () => {
    const m = { ...opus, id: "claude-haiku-5-5" };
    expect(newSnapshot({ ...base, model: m }).fallbacks).toBe(false);
    expect(newSnapshot({ ...base, model: opus }).fallbacks).toBe(true);
  });
  test("max tokens capped by the model; defaults when model unknown", () => {
    expect(newSnapshot({ ...base, model: { ...opus, maxTokens: 8000 } }).maxTokens).toBe(8000);
    const u = newSnapshot({ ...base, model: undefined });
    expect(u.maxTokens).toBe(32000);
    expect(u.thinking).toBe(true);
  });
  test("bakery mode: full, read for chime, null when off or unavailable", () => {
    expect(newSnapshot({ ...base, model: opus }).bakery).toBe("full");
    expect(newSnapshot({ ...base, model: opus, chime: true }).bakery).toBe("read");
    expect(newSnapshot({ ...base, model: opus, bakeryAvailable: false }).bakery).toBeNull();
    expect(newSnapshot({ ...base, model: opus, settings: { ...settings, bakery: false } }).bakery).toBeNull();
  });
  test("context goes last as a system message; system prompt follows bakery", () => {
    const s = newSnapshot({ ...base, model: opus });
    expect(s.messages.at(-1)).toEqual({ role: "system", content: "ctx" });
    expect(s.system).toBe(systemPrompt(true));
    expect(newSnapshot({ ...base, model: opus, bakeryAvailable: false }).system).toBe(systemPrompt(false));
    expect(s.model).toBe("claude-opus-5-5");
    expect(s.pauseCount).toBe(0);
  });
});

describe("prompts", () => {
  test("bakery line only in bakery variant", () => {
    expect(systemPrompt(true)).toContain(BAKERY_LINE);
    expect(systemPrompt(false)).not.toContain(BAKERY_LINE);
    expect(systemPrompt(false)).toBe(SYSTEM_BASE);
  });

  const now = new Date("2026-07-01T09:30:00Z"); // 12:30 Israel (DST)
  const trig = (over: Partial<RunTrigger> = {}): RunTrigger => ({
    type: "mention", messageId: 5, targetMessageId: 5, requesterId: 1, requesterName: "Dana", ...over,
  });
  test("mention context: time, title, requester, focus", () => {
    const c = contextMessage({ now, groupTitle: "Bakers", trigger: trig(), chime: false });
    expect(c).toContain("2026-07-01 12:30");
    expect(c).toContain("Bakers");
    expect(c).toContain("mention");
    expect(c).toContain("Dana");
    expect(c).toContain("respond to message #5");
  });
  test("reaction context names the emoji and the target", () => {
    const c = contextMessage({ now, groupTitle: "G", trigger: trig({ type: "reaction", emoji: "👾", targetMessageId: 9 }), chime: false });
    expect(c).toContain("Dana reacted 👾 to message #9, respond about that message");
  });
  test("chime context says to stay brief or silent", () => {
    const c = contextMessage({ now, groupTitle: "G", trigger: trig({ type: "chime", requesterId: null, requesterName: null }), chime: true });
    expect(c).toContain("You are interjecting uninvited. Be brief. If on reflection it is not clearly useful, reply with nothing at all.");
  });
  test("focusText is included when given", () => {
    const c = contextMessage({ now, groupTitle: "G", trigger: trig(), chime: false, focusText: "the cake photo" });
    expect(c).toContain("the cake photo");
  });
});

describe("bakeryConfig", () => {
  test("needs both vars", () => {
    expect(bakeryConfig({ BAKERY_URL: "https://b", BAKERY_MCP_KEY: "k" })).toEqual({ url: "https://b", key: "k" });
    expect(bakeryConfig({ BAKERY_URL: "https://b" })).toBeNull();
    expect(bakeryConfig({ BAKERY_MCP_KEY: "k" })).toBeNull();
  });
  test("strips a trailing slash from the url", () => {
    expect(bakeryConfig({ BAKERY_URL: "https://b/", BAKERY_MCP_KEY: "k" })?.url).toBe("https://b");
  });
});
