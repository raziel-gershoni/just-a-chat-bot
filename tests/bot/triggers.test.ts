import { describe, expect, it } from "vitest";
import type { Message, MessageReactionUpdated } from "grammy/types";
import { detectTrigger, reactionTrigger } from "@/src/bot/triggers";
import { BOT, groupMsg, user } from "../helpers/fixtures";

const ctx = { botId: BOT.id, botUsername: "MyBot" };

describe("detectTrigger", () => {
  it("detects an @mention entity", () => {
    const m = groupMsg(1, 1, { text: "hi @MyBot", entities: [{ type: "mention", offset: 3, length: 6 }] });
    expect(detectTrigger(m, ctx)).toBe("mention");
  });
  it("is case-insensitive", () => {
    const m = groupMsg(1, 1, { text: "hi @mybot", entities: [{ type: "mention", offset: 3, length: 6 }] });
    expect(detectTrigger(m, ctx)).toBe("mention");
  });
  it("ignores another bot's mention", () => {
    const m = groupMsg(1, 1, { text: "@otherbot", entities: [{ type: "mention", offset: 0, length: 9 }] });
    expect(detectTrigger(m, ctx)).toBeNull();
  });
  it("detects a text_mention of the bot", () => {
    const m = groupMsg(1, 1, { text: "hey you", entities: [{ type: "text_mention", offset: 4, length: 3, user: BOT }] });
    expect(detectTrigger(m, ctx)).toBe("mention");
  });
  it("detects a reply to the bot", () => {
    const m = groupMsg(1, 2, { reply_to_message: groupMsg(1, 1, { from: BOT }) });
    expect(detectTrigger(m, ctx)).toBe("reply");
  });
  it("ignores a reply to a human", () => {
    const m = groupMsg(1, 2, { reply_to_message: groupMsg(1, 1) });
    expect(detectTrigger(m, ctx)).toBeNull();
  });
  it("detects a mention in a caption", () => {
    const m = groupMsg(1, 1, {
      text: undefined, caption: "look @MyBot", caption_entities: [{ type: "mention", offset: 5, length: 6 }],
    }) as Message;
    expect(detectTrigger(m, ctx)).toBe("mention");
  });
});

describe("reactionTrigger", () => {
  const r = (o: string[], n: string[]) => ({
    old_reaction: o.map((emoji) => ({ type: "emoji", emoji })),
    new_reaction: n.map((emoji) => ({ type: "emoji", emoji })),
    user: user(1),
  }) as unknown as MessageReactionUpdated;
  it("fires when the emoji is newly added", () => expect(reactionTrigger(r([], ["👾"]), "👾")).toBe(true));
  it("does not fire when it was already there", () => expect(reactionTrigger(r(["👾"], ["👾", "👍"]), "👾")).toBe(false));
  it("ignores custom emoji", () => {
    const upd = { old_reaction: [], new_reaction: [{ type: "custom_emoji", custom_emoji_id: "1" }] } as unknown as MessageReactionUpdated;
    expect(reactionTrigger(upd, "👾")).toBe(false);
  });
});
