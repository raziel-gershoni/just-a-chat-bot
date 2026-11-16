// Inline <head> script that runs right after Telegram's script and before React: it sets <html lang dir>
// from the viewer's Telegram language, so a Hebrew page never flashes left-to-right.
// Same rule as pickLang in src/i18n (pinned by tests/app/lang-script.test.ts).
export const LANG_SCRIPT = `try {
  var tg = window.Telegram && window.Telegram.WebApp;
  var user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  var code = String((user && user.language_code) || "").toLowerCase();
  var lang = code.indexOf("he") === 0 || code.indexOf("iw") === 0 ? "he" : code.indexOf("ru") === 0 ? "ru" : "en";
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "he" ? "rtl" : "ltr";
} catch (e) {
  console.warn("[layout] pre-hydration language setup failed", e);
}`;
