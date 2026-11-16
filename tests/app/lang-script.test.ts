import { describe, expect, it, vi } from "vitest";
import { LANG_SCRIPT } from "@/app/lang-script";
import { pickLang } from "@/src/i18n";

// Runs the pre-hydration script against a fake window/document, as the browser would before React loads.
function run(win: unknown) {
  const root = { dir: "", lang: "en" };
  new Function("window", "document", LANG_SCRIPT)(win, { documentElement: root });
  return root;
}
const tgWith = (code?: string) => ({ Telegram: { WebApp: { initDataUnsafe: { user: code === undefined ? {} : { language_code: code } } } } });

describe("LANG_SCRIPT", () => {
  it("sets lang and dir from the Telegram language exactly as pickLang does", () => {
    for (const code of ["he", "he-IL", "iw", "IW", "ru", "ru-RU", "en", "fr", "", undefined]) {
      const lang = pickLang(code);
      expect(run(tgWith(code)), String(code)).toEqual({ lang, dir: lang === "he" ? "rtl" : "ltr" });
    }
  });

  it("falls back to English when Telegram's script is missing", () => {
    expect(run({})).toEqual({ lang: "en", dir: "ltr" });
  });

  it("logs instead of throwing when the page can't be touched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => new Function("window", "document", LANG_SCRIPT)(tgWith("he"), {})).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
