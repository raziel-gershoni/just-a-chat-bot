import { describe, expect, it } from "vitest";
import { en } from "@/src/i18n/en";
import { he } from "@/src/i18n/he";
import { ru } from "@/src/i18n/ru";
import { fill, LANG_NAMES, pickLang, t } from "@/src/i18n";

describe("pickLang", () => {
  it("maps Telegram language codes", () => {
    expect(pickLang("he-IL")).toBe("he");
    expect(pickLang("iw")).toBe("he");
    expect(pickLang("ru")).toBe("ru");
    expect(pickLang("fr")).toBe("en");
    expect(pickLang(undefined)).toBe("en");
    expect(pickLang(null)).toBe("en");
  });
});

describe("catalogs", () => {
  it("has every en key, non-empty, in he and ru, and no extras", () => {
    for (const [name, cat] of [["he", he], ["ru", ru]] as const) {
      expect(Object.keys(cat).sort(), name).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en)) expect((cat as Record<string, string>)[k]?.trim(), `${name}.${k}`).toBeTruthy();
    }
  });
  it("has the required keys", () => {
    for (const k of ["groupsOnly", "ownerMissingLeaving", "welcome", "settingsButton", "adminHint", "refusal", "cutShort", "runFailed", "sourcesLabel", "bakeryApprove", "bakeryReject", "bakeryUnreachable", "bakeryUnavailableNotice", "noNewerMessages"]) {
      expect(en, k).toHaveProperty(k);
    }
  });
  it("has the Mini App keys", () => {
    const keys = [
      "miniLoading", "miniSubtitle", "miniErrorInvalid", "miniErrorUnknownGroup", "miniErrorNotMember", "miniErrorFailed",
      "miniSaving", "miniSaved", "miniSaveFailed", "miniModel", "miniEffort", "miniEffortHint",
      "miniEffortLow", "miniEffortMedium", "miniEffortHigh", "miniEffortXhigh", "miniEffortMax",
      "miniChime", "miniChimeSwitch", "miniEagerness", "miniEagernessLow", "miniEagernessMedium", "miniEagernessHigh",
      "miniTrigger", "miniTriggerHint", "miniLanguage", "miniLanguageHint", "miniMemory", "miniMemoryHint",
      "miniBakery", "miniBakerySwitch", "miniBakeryHint", "miniBakeryNotConfigured",
      "miniForget", "miniForgetHint", "miniForgetConfirm", "miniForgetYes", "miniCancel", "miniForgetDone", "miniForgetFailed",
    ];
    for (const k of keys) expect(en, k).toHaveProperty(k);
  });
  it("names every bot language in its own language", () => {
    expect(LANG_NAMES).toEqual({ he: "עברית", en: "English", ru: "Русский" });
  });
});

describe("t", () => {
  it("returns the Hebrew approve label", () => {
    expect(t("he", "bakeryApprove")).toBe("אשר");
    expect(t("he", "bakeryReject")).toBe("בטל");
  });
  it("leaves no placeholders in welcome", () => {
    for (const l of ["en", "he", "ru"] as const) expect(t(l, "welcome", { settings: "x" })).not.toContain("{");
  });
  it("substitutes {name} placeholders", () => {
    expect(fill("Hi {name}, {name}! {other}", { name: "Dana", n: 3 })).toBe("Hi Dana, Dana! {other}");
    expect(t("en", "welcome", { name: "Dana" })).toBe(t("en", "welcome"));
  });
});
