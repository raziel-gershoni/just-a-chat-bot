// One JSON line per event, so Railway's log search can filter on fields. Never throws: the
// caller's fields come first so `ts` and `event` always win, and a value JSON can't encode
// (a BigInt, a circular object) is replaced instead of failing the logging call.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { ...fields, ts: new Date().toISOString(), event };
  let text: string;
  try {
    text = JSON.stringify(line, safeValue());
  } catch (err) {
    // A throwing toJSON or getter: keep the event, say why the fields are missing.
    text = JSON.stringify({ ts: line.ts, event, log_error: err instanceof Error ? err.message : String(err) });
  }
  console.log(text);
}

// JSON.stringify replacer: BigInt as a string, a repeated (circular) object as "[circular]".
function safeValue() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  };
}
