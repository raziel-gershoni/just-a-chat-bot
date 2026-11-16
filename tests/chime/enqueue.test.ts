import { describe, expect, it } from "vitest";
import { createChimeRun } from "@/src/chime/enqueue";
import { insertMessage } from "@/src/db/repo/messages";
import type { RunTrigger } from "@/src/db/schema";
import { testDb } from "../helpers/db";
import { msg, seedGroup } from "../helpers/db-fixtures";

const trig = (id: number): RunTrigger => ({
  type: "chime", messageId: id, targetMessageId: id, requesterId: null, requesterName: null,
});

describe("createChimeRun", () => {
  it("creates the run in the target message's forum thread", async () => {
    const db = await testDb();
    await seedGroup(db, 1);
    await insertMessage(db, msg(1, 5, { threadId: 7 }));
    expect((await createChimeRun(db, 1, trig(5)))!.threadId).toBe(7);
  });

  it("uses a null thread for a General / non-forum message", async () => {
    const db = await testDb();
    await seedGroup(db, 1);
    await insertMessage(db, msg(1, 6));
    expect((await createChimeRun(db, 1, trig(6)))!.threadId).toBeNull();
  });
});
