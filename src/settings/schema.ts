import { z } from "zod";
import { log } from "../util/log";
import type { Lang } from "../i18n";
import { REACTION_EMOJIS } from "./emojis";
import { HISTORY_WINDOWS } from "./windows";

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const eagernessSchema = z.enum(["low", "medium", "high"]);
export const languageSchema = z.enum(["he", "en", "ru"]);
export const historyWindowSchema = z.number().refine((n) => (HISTORY_WINDOWS as readonly number[]).includes(n));
export const triggerEmojiSchema = z.string().refine((e) => REACTION_EMOJIS.includes(e));
export const chimeSchema = z.strictObject({ enabled: z.boolean(), eagerness: eagernessSchema });

/** The single definition of a valid settings blob. parseSettings and the Mini App PUT both derive from it. */
export const settingsSchema = z.strictObject({
  model: z.string().min(1),
  effort: effortSchema,
  chime: chimeSchema,
  triggerEmoji: triggerEmojiSchema,
  historyWindow: historyWindowSchema,
  language: languageSchema,
  bakery: z.boolean(),
});

/** A partial update: every field optional, chime's fields optional too. */
export const settingsPatchSchema = settingsSchema.extend({ chime: chimeSchema.partial() }).partial();

export type GroupSettings = {
  model: string;
  effort: z.infer<typeof effortSchema>;
  chime: { enabled: boolean; eagerness: z.infer<typeof eagernessSchema> };
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
    model: field("model", settingsSchema.shape.model, r.model, d.model),
    effort: field("effort", effortSchema, r.effort, d.effort),
    chime: {
      enabled: field("chime.enabled", chimeSchema.shape.enabled, chimeRaw.enabled, d.chime.enabled),
      eagerness: field("chime.eagerness", eagernessSchema, chimeRaw.eagerness, d.chime.eagerness),
    },
    triggerEmoji: field("triggerEmoji", triggerEmojiSchema, r.triggerEmoji, d.triggerEmoji),
    historyWindow: field("historyWindow", historyWindowSchema, r.historyWindow, d.historyWindow),
    language: field("language", languageSchema, r.language, d.language),
    bakery: field("bakery", settingsSchema.shape.bakery, r.bakery, d.bakery),
  };
}
