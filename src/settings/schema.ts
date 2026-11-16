import { z } from "zod";
import { log } from "../util/log";
import type { Lang } from "../i18n";
import { REACTION_EMOJIS } from "./emojis";

export const HISTORY_WINDOWS = [50, 100, 200, 400] as const;

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const eagerness = z.enum(["low", "medium", "high"]);
const language = z.enum(["he", "en", "ru"]);
const historyWindow = z.number().refine((n) => (HISTORY_WINDOWS as readonly number[]).includes(n));
const triggerEmoji = z.string().refine((e) => REACTION_EMOJIS.includes(e));

export type GroupSettings = {
  model: string;
  effort: z.infer<typeof effort>;
  chime: { enabled: boolean; eagerness: z.infer<typeof eagerness> };
  triggerEmoji: string;
  historyWindow: number;
  language: Lang;
  bakery: boolean;
};

export function defaultSettings(lang: Lang): GroupSettings {
  return {
    model: "claude-opus-5-5",
    effort: "medium",
    chime: { enabled: true, eagerness: "low" },
    triggerEmoji: "👾",
    historyWindow: 100,
    language: lang,
    bakery: false,
  };
}

function field<T>(field: string, schema: z.ZodType<T>, value: unknown, fallback: T): T {
  if (value === undefined) return fallback;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  log("settings.invalid_field", { field, issue: r.error.issues[0]?.message ?? "invalid" });
  return fallback;
}

// Merges stored settings over the defaults field by field. A bad field falls back to its default
// (and is logged); a bad blob falls back to all defaults. Never throws.
export function parseSettings(raw: unknown): GroupSettings {
  const d = defaultSettings("en");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) log("settings.invalid_blob", { type: typeof raw });
    return d;
  }
  const r = raw as Record<string, unknown>;
  let chimeRaw: Record<string, unknown> = {};
  if (typeof r.chime === "object" && r.chime !== null && !Array.isArray(r.chime)) {
    chimeRaw = r.chime as Record<string, unknown>;
  } else if (r.chime !== undefined) {
    log("settings.invalid_field", { field: "chime", issue: "not an object" });
  }
  return {
    model: field("model", z.string().min(1), r.model, d.model),
    effort: field("effort", effort, r.effort, d.effort),
    chime: {
      enabled: field("chime.enabled", z.boolean(), chimeRaw.enabled, d.chime.enabled),
      eagerness: field("chime.eagerness", eagerness, chimeRaw.eagerness, d.chime.eagerness),
    },
    triggerEmoji: field("triggerEmoji", triggerEmoji, r.triggerEmoji, d.triggerEmoji),
    historyWindow: field("historyWindow", historyWindow, r.historyWindow, d.historyWindow),
    language: field("language", language, r.language, d.language),
    bakery: field("bakery", z.boolean(), r.bakery, d.bakery),
  };
}
