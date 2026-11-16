import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { errorText } from "@/src/util/errors";

describe("errorText", () => {
  it("scrubs bot tokens", () => {
    const t = errorText(
      new Error("GET https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq/sendMessage failed"),
    );
    expect(t).toContain("[bot-token]");
    expect(t).not.toContain("AAHdq");
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
