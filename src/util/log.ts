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

// JSON.stringify replacer: BigInt as a string, an object that contains itself (a real cycle) as
// "[circular]". Only the ancestors of the current value count, so a shared, non-circular
// reference is logged in full wherever it appears.
function safeValue() {
  const ancestors: object[] = [];
  return function (this: unknown, _key: string, value: unknown) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      // `this` is the holder of this value: everything above it on the stack is a finished sibling branch.
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(value)) return "[circular]";
      ancestors.push(value);
    }
    return value;
  };
}
