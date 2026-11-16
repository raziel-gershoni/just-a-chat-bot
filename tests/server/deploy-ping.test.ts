import { describe, expect, it } from "vitest";
import { t } from "@/src/i18n";
import { deployPing } from "@/src/server/deploy-ping";
import { testDb } from "../helpers/db";
import { fakeTg } from "../helpers/fake-tg";

const sent = (tg: ReturnType<typeof fakeTg>) => tg.calls.filter((c) => c.method === "sendMessage");

describe("deployPing", () => {
  it("sends once per sha, again for a new sha", async () => {
    const db = await testDb();
    const tg = fakeTg();
    const base = { db, tg, ownerId: 42 };

    expect(await deployPing({ ...base, sha: "abcdef1234567", message: "feat: x\n\nbody" })).toBe(true);
    expect(sent(tg)).toHaveLength(1);
    expect(sent(tg)[0]!.args.slice(0, 2)).toEqual([42, "just-a-chat-bot deployed abcdef1: feat: x"]);

    expect(await deployPing({ ...base, sha: "abcdef1234567", message: "feat: x" })).toBe(false);
    expect(sent(tg)).toHaveLength(1);

    expect(await deployPing({ ...base, sha: "def", message: "fix: y" })).toBe(true);
    expect(sent(tg)).toHaveLength(2);
  });

  it("drops the separator when the commit message is empty, and speaks the given language", async () => {
    const tg = fakeTg();
    expect(await deployPing({ db: await testDb(), tg, ownerId: 42, sha: "abcdef1234567", message: "  \n" })).toBe(true);
    expect(sent(tg)[0]!.args[1]).toBe("just-a-chat-bot deployed abcdef1");
    const tg2 = fakeTg();
    expect(await deployPing({ db: await testDb(), tg: tg2, ownerId: 42, sha: "abc1234", message: "fix: y", lang: "he" })).toBe(true);
    expect(sent(tg2)[0]!.args[1]).toBe(t("he", "deployPing", { sha: "abc1234", message: "fix: y" }));
  });

  it("does nothing without a sha", async () => {
    const tg = fakeTg();
    expect(await deployPing({ db: await testDb(), tg, ownerId: 42 })).toBe(false);
    expect(sent(tg)).toHaveLength(0);
  });
});
