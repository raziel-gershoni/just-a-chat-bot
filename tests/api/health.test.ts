import { expect, test } from "vitest";
import { testDb } from "@/tests/helpers/db";
import { handleHealth } from "@/app/api/health/route";

test("handleHealth returns ok when the db answers", async () => {
  const res = await handleHealth(await testDb());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("handleHealth returns 503 when the db fails", async () => {
  const bad = { select: () => { throw new Error("down"); } } as never;
  const res = await handleHealth(bad);
  expect(res.status).toBe(503);
});
