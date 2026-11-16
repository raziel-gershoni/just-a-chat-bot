import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { log } from "@/src/util/log";

let spy: MockInstance;
beforeEach(() => {
  spy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => spy.mockRestore());
const line = () => JSON.parse(String(spy.mock.calls.at(-1)![0])) as Record<string, unknown>;

describe("log", () => {
  it("caller fields can't overwrite ts or event", () => {
    log("real.event", { event: "fake", ts: "never", chat_id: 1 });
    expect(line()).toMatchObject({ event: "real.event", chat_id: 1 });
    expect(line().ts).not.toBe("never");
  });

  it("never throws on a BigInt or a circular value", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => log("x", { big: 10n, a })).not.toThrow();
    expect(line()).toMatchObject({ event: "x", big: "10", a: { name: "a", self: "[circular]" } });
  });

  it("keeps a shared, non-circular reference everywhere it appears", () => {
    const arr = [1, 2];
    log("z", { a: arr, b: arr, c: { d: arr } });
    expect(line()).toMatchObject({ a: [1, 2], b: [1, 2], c: { d: [1, 2] } });
  });

  it("a throwing toJSON still logs the event", () => {
    expect(() => log("y", { bad: { toJSON() { throw new Error("nope"); } } })).not.toThrow();
    expect(line()).toMatchObject({ event: "y", log_error: "nope" });
  });
});
