export const BAKERY_READ_TOOLS = ["list_breads", "get_recipes", "get_ingredient_prices", "get_loaf_costs", "get_sales"] as const;

// Read from env at call time and never stored (not in run snapshots, not in the DB).
export function bakeryConfig(env: { BAKERY_URL?: string; BAKERY_MCP_KEY?: string }): { url: string; key: string } | null {
  if (!env.BAKERY_URL || !env.BAKERY_MCP_KEY) return null;
  return { url: env.BAKERY_URL.replace(/\/+$/, ""), key: env.BAKERY_MCP_KEY };
}
