import { DrizzleQueryError } from "drizzle-orm";

// drizzle-orm wraps driver errors in a DrizzleQueryError whose message embeds the full SQL and
// its bound parameters (message text). Report the driver's own error instead.
function withoutQuery(err: unknown): unknown {
  if (err instanceof DrizzleQueryError) return err.cause ?? new Error("database query failed");
  return err;
}

// The one place server code turns a caught error into text for logs. Secrets never leave it.
export function errorText(err: unknown): string {
  const e = withoutQuery(err);
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[bot-token]").replace(/bmcp_[A-Za-z0-9_-]+/g, "[bakery-key]");
}
