import { describe, expect, it, vi } from "vitest";
import { handleWebhook } from "@/app/api/telegram/route";
import { testDb } from "../helpers/db";

const SECRET = "s3cret";
const post = (body: unknown, secret: string | null = SECRET) =>
  new Request("http://x/api/telegram", {
    method: "POST",
    headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function setup(handle = vi.fn().mockResolvedValue(undefined)) {
  const db = await testDb();
  return { handle, deps: { secret: SECRET, db, handle } };
}

describe("handleWebhook", () => {
  it("rejects a wrong secret with 401 and does not handle", async () => {
    const { handle, deps } = await setup();
    const res = await handleWebhook(post({ update_id: 1 }, "nope"), deps);
    expect(res.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects a missing secret with 401", async () => {
    const { handle, deps } = await setup();
    expect((await handleWebhook(post({ update_id: 1 }, null), deps)).status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it("answers 400 on bad JSON", async () => {
    const { handle, deps } = await setup();
    expect((await handleWebhook(post("{not json"), deps)).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("answers 400 when update_id is missing", async () => {
    const { handle, deps } = await setup();
    expect((await handleWebhook(post({ message: {} }), deps)).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it("handles the same update once and answers 200 both times", async () => {
    const { handle, deps } = await setup();
    expect((await handleWebhook(post({ update_id: 7 }), deps)).status).toBe(200);
    expect((await handleWebhook(post({ update_id: 7 }), deps)).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("answers 500 when handle throws and handles the redelivery again", async () => {
    const handle = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const { deps } = await setup(handle);
    expect((await handleWebhook(post({ update_id: 9 }), deps)).status).toBe(500);
    expect((await handleWebhook(post({ update_id: 9 }), deps)).status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(2);
  });
});
