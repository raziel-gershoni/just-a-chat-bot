import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { BAKERY_READ_TOOLS } from "../bakery/config";
import type { RunSnapshot } from "../db/schema";
import type { ModelInfoLite } from "../models/catalog";
import type { GroupSettings } from "../settings/schema";
import { systemPrompt } from "./prompts";

const MCP_BETA = "mcp-client-2026-09-15";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_MAX_TOKENS = 32000;

// Pure function of the snapshot (plus the bakery config, read from env by the caller), so two
// calls give identical JSON and the prompt cache holds. The key is only ever added here.
export function buildParams(snap: RunSnapshot, bakery: { url: string; key: string } | null): BetaMessageStreamParams {
  const useMcp = Boolean(snap.bakery && bakery && !snap.bakeryDropped);
  const tools: Record<string, unknown>[] = [
    { type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
    { type: "web_fetch_20260318", name: "web_fetch", allowed_callers: ["direct"] },
  ];
  const betas: string[] = [];
  const params: Record<string, unknown> = {
    model: snap.model,
    max_tokens: snap.maxTokens,
    system: [{ type: "text", text: snap.system, cache_control: { type: "ephemeral" } }],
    messages: snap.messages,
    output_config: { effort: snap.effort },
    tools,
  };
  if (snap.thinking) params.thinking = { type: "adaptive" };
  if (useMcp && bakery) {
    tools.push(
      snap.bakery === "read"
        ? {
            type: "mcp_toolset",
            mcp_server_name: "bakery",
            default_config: { enabled: false },
            configs: Object.fromEntries(BAKERY_READ_TOOLS.map((n) => [n, { enabled: true }])),
          }
        : { type: "mcp_toolset", mcp_server_name: "bakery" },
    );
    params.mcp_servers = [{ type: "url", name: "bakery", url: `${bakery.url}/api/mcp`, authorization_token: bakery.key }];
    betas.push(MCP_BETA);
  }
  if (snap.fallbacks) {
    betas.push(FALLBACK_BETA);
    params.fallbacks = "default";
  }
  if (betas.length) params.betas = betas;
  return params as unknown as BetaMessageStreamParams;
}

export function newSnapshot(input: {
  settings: GroupSettings;
  model: ModelInfoLite | undefined;
  bakeryAvailable: boolean;
  chime: boolean;
  transcript: unknown[];
  context: string;
}): RunSnapshot {
  const { settings, model } = input;
  const bakery = settings.bakery && input.bakeryAvailable ? (input.chime ? "read" : "full") : null;
  return {
    model: settings.model,
    effort: settings.effort,
    maxTokens: Math.min(DEFAULT_MAX_TOKENS, model?.maxTokens ?? DEFAULT_MAX_TOKENS),
    thinking: model?.adaptive ?? true,
    // Haiku rejects the fallbacks parameter with a 400.
    fallbacks: !(model?.id ?? settings.model).startsWith("claude-haiku"),
    bakery,
    system: systemPrompt(bakery !== null),
    context: input.context,
    messages: [...input.transcript, { role: "system", content: input.context }],
    pauseCount: 0,
    startIndex: input.transcript.length + 1,
  };
}
