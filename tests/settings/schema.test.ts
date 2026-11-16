import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, parseSettings } from "@/src/settings/schema";
import { REACTION_EMOJIS } from "@/src/settings/emojis";

afterEach(() => vi.restoreAllMocks());

describe("parseSettings", () => {
  it("returns defaults for empty or non-object input", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(parseSettings({})).toEqual(defaultSettings("en"));
    expect(parseSettings(null)).toEqual(defaultSettings("en"));
    expect(parseSettings("junk")).toEqual(defaultSettings("en"));
  });
  it("drops an invalid field, keeps the valid ones, and logs", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = parseSettings({ effort: "bogus", historyWindow: 200 });
    expect(s.effort).toBe("medium");
    expect(s.historyWindow).toBe(200);
    expect(spy).toHaveBeenCalled();
  });
  it("rejects a trigger emoji outside the allowed reactions", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(parseSettings({ triggerEmoji: "🤖" }).triggerEmoji).toBe("👾");
    expect(parseSettings({ triggerEmoji: "🔥" }).triggerEmoji).toBe("🔥");
  });
  it("rejects historyWindow outside the choices", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(parseSettings({ historyWindow: 75 }).historyWindow).toBe(100);
  });
  it("merges nested chime fields with defaults", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(parseSettings({ chime: { eagerness: "high" } }).chime).toEqual({ enabled: true, eagerness: "high", cooldownMinutes: 3 });
    expect(parseSettings({ chime: { eagerness: "wild", enabled: false } }).chime).toEqual({ enabled: false, eagerness: "low", cooldownMinutes: 3 });
    expect(parseSettings({ chime: 5 }).chime).toEqual({ enabled: true, eagerness: "low", cooldownMinutes: 3 });
    expect(parseSettings({ chime: { cooldownMinutes: 10 } }).chime.cooldownMinutes).toBe(10);
    expect(parseSettings({ chime: { cooldownMinutes: 0 } }).chime.cooldownMinutes).toBe(0);
    expect(parseSettings({ chime: { cooldownMinutes: 7 } }).chime.cooldownMinutes).toBe(3);
  });
  it("keeps valid language and bakery", () => {
    const s = parseSettings({ language: "he", bakery: true });
    expect(s.language).toBe("he");
    expect(s.bakery).toBe(true);
  });
});

describe("defaultSettings", () => {
  it("uses the given language and the spec defaults", () => {
    expect(defaultSettings("ru")).toEqual({
      model: "claude-opus-5-5", effort: "medium", chime: { enabled: true, eagerness: "low", cooldownMinutes: 3 },
      triggerEmoji: "👾", historyWindow: 100, language: "ru", bakery: false,
    });
  });
});

describe("REACTION_EMOJIS", () => {
  it("contains the default and not an unsupported emoji", () => {
    expect(REACTION_EMOJIS.includes("👾")).toBe(true);
    expect(REACTION_EMOJIS.includes("🤖")).toBe(false);
    expect(REACTION_EMOJIS).toHaveLength(73);
    expect(new Set(REACTION_EMOJIS).size).toBe(REACTION_EMOJIS.length);
  });
});
