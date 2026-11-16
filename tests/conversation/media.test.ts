import { describe, expect, it, vi } from "vitest";
import { ensureUploaded } from "@/src/conversation/media";
import { testDb } from "../helpers/db";
import { msg, seedGroup } from "../helpers/db-fixtures";
import { fakeTg } from "../helpers/fake-tg";
import { insertMessage, getMessage } from "@/src/db/repo/messages";

async function setup() {
  const db = await testDb();
  await seedGroup(db);
  const row = (await insertMessage(db, msg(1, 5, { media: { kind: "photo", fileId: "tg1", label: "photo" } })))!;
  const tg = fakeTg();
  const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
  return { db, row, tg, fetchFn };
}

describe("ensureUploaded", () => {
  it("returns the cached id without calling getFile", async () => {
    const { db, row, tg, fetchFn } = await setup();
    const upload = vi.fn();
    const id = await ensureUploaded({ db, tg, token: "T", fetch: fetchFn, upload }, { ...row, anthropicFileId: "cached" });
    expect(id).toBe("cached");
    expect(tg.calls.filter((c) => c.method === "getFile")).toHaveLength(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it("downloads, uploads as image/jpeg and caches the id", async () => {
    const { db, row, tg, fetchFn } = await setup();
    const upload = vi.fn(async () => "file_9");
    const id = await ensureUploaded({ db, tg, token: "T", fetch: fetchFn, upload }, row);
    expect(id).toBe("file_9");
    expect(upload).toHaveBeenCalledWith(expect.any(Buffer), expect.any(String), "image/jpeg");
    expect((await getMessage(db, 1, 5))!.anthropicFileId).toBe("file_9");
  });

  it("returns null and does not throw when the upload fails", async () => {
    const { db, row, tg, fetchFn } = await setup();
    const upload = vi.fn(async () => { throw new Error("boom"); });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const id = await ensureUploaded({ db, tg, token: "T", fetch: fetchFn, upload }, row);
    expect(id).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).includes("media.upload_failed"))).toBe(true);
    spy.mockRestore();
    expect((await getMessage(db, 1, 5))!.anthropicFileId).toBeNull();
  });

  it("fails (null) on a non-ok download", async () => {
    const { db, row, tg } = await setup();
    const upload = vi.fn();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bad = vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await ensureUploaded({ db, tg, token: "T", fetch: bad, upload }, row)).toBeNull();
    spy.mockRestore();
    expect(upload).not.toHaveBeenCalled();
  });
});
