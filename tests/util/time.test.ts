import { describe, expect, it } from "vitest";
import { israelTime } from "@/src/util/time";

describe("israelTime", () => {
  it("uses UTC+3 in summer", () => {
    expect(israelTime(new Date("2026-07-01T09:05:00Z"))).toBe("2026-07-01 12:05");
  });
  it("uses UTC+2 in winter", () => {
    expect(israelTime(new Date("2026-12-01T09:05:00Z"))).toBe("2026-12-01 11:05");
  });
  it("renders midnight as 00, not 24", () => {
    expect(israelTime(new Date("2026-12-01T22:00:00Z"))).toBe("2026-12-02 00:00");
  });
});
