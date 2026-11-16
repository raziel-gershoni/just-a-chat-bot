import { en, type MsgKey } from "./en";
import { he } from "./he";
import { ru } from "./ru";

export type Lang = "he" | "en" | "ru";
export type { MsgKey };

const catalogs: Record<Lang, Record<MsgKey, string>> = { en, he, ru };

// Each language's own name for itself, the same whatever the UI language.
export const LANG_NAMES: Record<Lang, string> = { he: "עברית", en: "English", ru: "Русский" };

// Telegram language_code → bot language. Old Hebrew code "iw" counts as Hebrew.
export function pickLang(code?: string | null): Lang {
  const c = (code ?? "").toLowerCase();
  if (c.startsWith("he") || c.startsWith("iw")) return "he";
  if (c.startsWith("ru")) return "ru";
  return "en";
}

// Replaces {name} placeholders; unknown placeholders stay as written.
export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function t(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  return fill(catalogs[lang][key], vars);
}
