import { describe, expect, it } from "vitest";
import { loadEnv } from "@/src/config/env";

const valid = {
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_WEBHOOK_SECRET: "s",
  TELEGRAM_OWNER_ID: "123",
  TELEGRAM_MINIAPP_SHORT_NAME: "settings",
  ANTHROPIC_API_KEY: "k",
  DATABASE_URL: "postgres://x",
  JWT_SECRET: "x".repeat(32),
};

describe("loadEnv", () => {
  it("parses the owner id as a number", () => {
    expect(loadEnv(valid).TELEGRAM_OWNER_ID).toBe(123);
  });
  it("names the missing variable", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
  it("rejects a non-numeric owner id", () => {
    expect(() => loadEnv({ ...valid, TELEGRAM_OWNER_ID: "abc" })).toThrow();
  });
  it("rejects a short JWT secret", () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: "short" })).toThrow();
  });
  it("maps the Railway variables", () => {
    const e = loadEnv({
      ...valid,
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      RAILWAY_GIT_COMMIT_SHA: "abc",
      RAILWAY_GIT_COMMIT_MESSAGE: "msg",
      RAILWAY_DEPLOYMENT_ID: "dep-1",
    });
    expect(e.DEPLOYMENT_ID).toBe("dep-1");
    expect(e.PUBLIC_DOMAIN).toBe("x.up.railway.app");
    expect(e.GIT_SHA).toBe("abc");
    expect(e.GIT_MESSAGE).toBe("msg");
  });
  it("treats empty optional variables as unset", () => {
    const e = loadEnv({ ...valid, BAKERY_URL: "", BAKERY_MCP_KEY: "" });
    expect(e.BAKERY_URL).toBeUndefined();
    expect(e.BAKERY_MCP_KEY).toBeUndefined();
  });
});
