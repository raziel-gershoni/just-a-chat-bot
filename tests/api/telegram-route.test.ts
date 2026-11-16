import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { handleWebhook } from "@/app/api/telegram/route";
import { isUpdateSeen } from "@/src/db/repo/updates";
import { createInflight } from "@/src/server/inflight";
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

  it("answers 500 when handle throws, leaves the update unmarked and handles the redelivery again", async () => {
    const handle = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const { deps } = await setup(handle);
    expect((await handleWebhook(post({ update_id: 9 }), deps)).status).toBe(500);
    expect(await isUpdateSeen(deps.db, 9)).toBe(false);
    expect((await handleWebhook(post({ update_id: 9 }), deps)).status).toBe(200);
    expect(await isUpdateSeen(deps.db, 9)).toBe(true);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("marks only after handling: an update cut off mid-handle is not marked", async () => {
    let finish!: () => void;
    const handle = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { deps } = await setup(handle);
    const pending = handleWebhook(post({ update_id: 11 }), deps);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(await isUpdateSeen(deps.db, 11)).toBe(false);
    finish();
    expect((await pending).status).toBe(200);
    expect(await isUpdateSeen(deps.db, 11)).toBe(true);
  });

  it("still answers 200 when the seen check and the mark fail after a successful handle", async () => {
    const { handle, deps } = await setup();
    await deps.db.execute(sql`drop table processed_updates`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await handleWebhook(post({ update_id: 12 }), deps)).status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    const events = log.mock.calls.map((c) => (JSON.parse(String(c[0])) as { event: string }).event);
    expect(events).toEqual(expect.arrayContaining(["webhook.seen_check_failed", "webhook.mark_failed"]));
    log.mockRestore();
  });

  it("counts the handler as in flight until it settles", async () => {
    let finish!: () => void;
    const handle = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { deps } = await setup(handle);
    const inflight = createInflight();
    const pending = handleWebhook(post({ update_id: 13 }), { ...deps, inflight });
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(inflight.count()).toBe(1);
    let idle = false;
    void inflight.idle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    finish();
    await pending;
    await vi.waitFor(() => expect(idle).toBe(true));
    expect(inflight.count()).toBe(0);
  });
});
