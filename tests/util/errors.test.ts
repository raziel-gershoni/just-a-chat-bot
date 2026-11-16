import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { errorText } from "@/src/util/errors";

// Built at runtime so secret scanners see no provider-shaped literal.
const fakeBotToken = ["123456789", "AA" + "x".repeat(33)].join(":");

describe("errorText", () => {
  it("scrubs bot tokens", () => {
    const t = errorText(
      new Error(`GET https://api.telegram.org/bot${fakeBotToken}/sendMessage failed`),
    );
    expect(t).toContain("[bot-token]");
    expect(t).not.toContain(fakeBotToken.split(":")[1]);
  });
  it("scrubs bakery keys", () => {
    expect(errorText("bad key bmcp_abc-DEF_123")).toBe("bad key [bakery-key]");
  });
  it("unwraps DrizzleQueryError to the driver error", () => {
    const err = new DrizzleQueryError("insert into t values ($1)", ["secret text"], new Error("duplicate key"));
    const t = errorText(err);
    expect(t).toBe("duplicate key");
    expect(t).not.toContain("secret text");
  });
});
