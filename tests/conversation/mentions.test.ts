import { describe, expect, it } from "vitest";
import { textWithTags } from "@/src/conversation/mentions";

const tm = (offset: number, length: number) => ({ type: "text_mention", offset, length, user: { id: 7, is_bot: false, first_name: "X" } });

describe("textWithTags", () => {
  it("marks a tag of a member without a username (text_mention) with @, like a username tag", () => {
    expect(textWithTags("ישועה הכוונה הייתה 900 גרם?", [tm(0, 5)])).toBe("@ישועה הכוונה הייתה 900 גרם?");
  });
  it("handles several tags, mid-text tags and UTF-16 offsets after an emoji", () => {
    // "👋 " is 3 UTF-16 code units, as Telegram counts offsets.
    expect(textWithTags("👋 Dana and Avi, look", [tm(3, 4), tm(12, 3)])).toBe("👋 @Dana and @Avi, look");
  });
  it("leaves username mentions, other entities and an existing @ alone", () => {
    const ents = [{ type: "mention", offset: 0, length: 5 }, { type: "bold", offset: 6, length: 2 }, tm(9, 4)];
    expect(textWithTags("@dana hi @Avi", ents)).toBe("@dana hi @Avi");
  });
  it("ignores missing or malformed entities", () => {
    expect(textWithTags("hi", null)).toBe("hi");
    expect(textWithTags("hi", [{ type: "text_mention" }, "x", null, { type: "text_mention", offset: 9, length: 2 }])).toBe("hi");
  });
});
