import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInitData } from "@/src/telegram/initdata";

const TOKEN = "123:abc";
const NOW = new Date("2026-11-16T12:00:00Z");

function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const fields = (ageS: number, extra: Record<string, string> = {}) => ({
  auth_date: String(Math.floor(NOW.getTime() / 1000) - ageS),
  user: JSON.stringify({ id: 99, first_name: "Dana", language_code: "he" }),
  start_param: "tok_1",
  ...extra,
});

describe("verifyInitData", () => {
  it("returns the user and start param for a valid string", () => {
    expect(verifyInitData(sign(fields(10)), TOKEN, NOW)).toEqual({
      user: { id: 99, firstName: "Dana", languageCode: "he" }, startParam: "tok_1",
    });
  });
  it("startParam is null when absent", () => {
    const f = fields(10); delete (f as Record<string, string>).start_param;
    expect(verifyInitData(sign(f), TOKEN, NOW)?.startParam).toBeNull();
  });
  it("rejects a tampered hash", () => {
    const s = sign(fields(10));
    expect(verifyInitData(s.replace(/.$/, c => (c === "0" ? "1" : "0")), TOKEN, NOW)).toBeNull();
  });
  it("rejects tampered data and a wrong token", () => {
    expect(verifyInitData(sign(fields(10)).replace("Dana", "Evil"), TOKEN, NOW)).toBeNull();
    expect(verifyInitData(sign(fields(10), "999:zzz"), TOKEN, NOW)).toBeNull();
  });
  it("rejects auth_date 2 h old, accepts 30 min", () => {
    expect(verifyInitData(sign(fields(7200)), TOKEN, NOW)).toBeNull();
    expect(verifyInitData(sign(fields(1800)), TOKEN, NOW)).not.toBeNull();
  });
  it("rejects empty, missing hash, missing user", () => {
    expect(verifyInitData("", TOKEN, NOW)).toBeNull();
    expect(verifyInitData("auth_date=1", TOKEN, NOW)).toBeNull();
    const f = fields(10); delete (f as Record<string, string>).user;
    expect(verifyInitData(sign(f), TOKEN, NOW)).toBeNull();
  });
});
