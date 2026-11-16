import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorScreen, LoadingScreen, SettingsForm, type FormProps } from "@/app/settings/SettingsApp";
import { t, type Lang, type MsgKey } from "@/src/i18n";
import { settingsView } from "@/tests/helpers/settings-view";

const noop = () => {};
function form(over: Partial<FormProps> = {}): string {
  const props: FormProps = { lang: "en", view: settingsView(), status: null, forget: { kind: "idle" }, onChange: noop, onForget: noop, ...over };
  return renderToStaticMarkup(createElement(SettingsForm, props));
}
// The localized text as React writes it into HTML.
const tx = (lang: Lang, key: MsgKey) => t(lang, key).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const label = (text: string) => `>${text}<`;

describe("ErrorScreen", () => {
  it("shows the localized text for each error code", () => {
    const keys = { invalid: "miniErrorInvalid", unknown_group: "miniErrorUnknownGroup", not_member: "miniErrorNotMember", failed: "miniErrorFailed" } as const;
    for (const lang of ["en", "he", "ru"] as Lang[]) {
      for (const [error, key] of Object.entries(keys)) {
        const html = renderToStaticMarkup(createElement(ErrorScreen, { lang, error: error as keyof typeof keys }));
        expect(html, `${lang} ${error}`).toContain(tx(lang, key));
        expect(html).toContain('role="alert"');
      }
    }
  });
  it("is right-to-left in Hebrew", () => {
    expect(renderToStaticMarkup(createElement(ErrorScreen, { lang: "he", error: "failed" }))).toContain('dir="rtl"');
    expect(renderToStaticMarkup(createElement(ErrorScreen, { lang: "en", error: "failed" }))).toContain('dir="ltr"');
  });
});

describe("LoadingScreen", () => {
  it("is busy, and has its text only once the language is known", () => {
    const none = renderToStaticMarkup(createElement(LoadingScreen, { lang: null }));
    expect(none).toContain('aria-busy="true"');
    const ru = renderToStaticMarkup(createElement(LoadingScreen, { lang: "ru" }));
    expect(ru).toContain(tx("ru", "miniLoading"));
  });
});

describe("SettingsForm", () => {
  it("shows the group title and every section in the viewer's language", () => {
    const html = form({ lang: "he" });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("Family");
    for (const k of ["miniModel", "miniEffort", "miniChime", "miniTrigger", "miniLanguage", "miniMemory", "miniForget"] as const) {
      expect(html, k).toContain(tx("he", k));
    }
  });

  it("lists the models by display name with the current one selected", () => {
    const html = form();
    expect(html).toContain('<option value="claude-opus-5-5" selected="">Claude Opus 5.5</option>');
    expect(html).toContain('<option value="claude-haiku-5-5">Claude Haiku 5.5</option>');
  });

  it("keeps a stored model that left the catalog selectable", () => {
    const v = settingsView();
    const html = form({ view: { ...v, settings: { ...v.settings, model: "claude-old-1" } } });
    expect(html).toContain('<option value="claude-old-1" selected="">claude-old-1</option>');
  });

  it("offers only the selected model's efforts", () => {
    const opus = form();
    for (const k of ["miniEffortLow", "miniEffortMedium", "miniEffortHigh", "miniEffortXhigh", "miniEffortMax"] as const) {
      expect(opus, k).toContain(label(tx("en", k)));
    }
    const v = settingsView();
    const haiku = form({ view: { ...v, settings: { ...v.settings, model: "claude-haiku-5-5" } } });
    expect(haiku).toContain(label(tx("en", "miniEffortHigh")));
    expect(haiku).not.toContain(label(tx("en", "miniEffortXhigh")));
    expect(haiku).not.toContain(label(tx("en", "miniEffortMax")));
  });

  it("hides the effort section for a model without effort levels", () => {
    const v = settingsView();
    const html = form({ view: { ...v, models: [{ ...v.models[0]!, efforts: [] }] } });
    expect(html).not.toContain(tx("en", "miniEffort"));
  });

  it("marks the current choice in each segmented control and the emoji grid", () => {
    const html = form();
    expect(html).toMatch(/aria-checked="true"[^>]*>👾</);
    expect(html).toMatch(/aria-checked="false"[^>]*>🔥</);
    expect(html).toMatch(new RegExp(`aria-checked="true"[^>]*${label(tx("en", "miniEffortMedium"))}`));
    expect(html).toMatch(new RegExp(`aria-checked="true"[^>]*${label(tx("en", "miniEagernessLow"))}`));
    expect(html).toMatch(/aria-checked="true"[^>]*>English</);
    expect(html).toMatch(/aria-checked="true"[^>]*>100</);
    expect(html).toMatch(/aria-checked="false"[^>]*>400</);
    expect(html).toMatch(new RegExp(`role="switch" aria-checked="true"[^>]*>(?:(?!</button>).)*${tx("en", "miniChimeSwitch")}`));
  });

  it("hides the eagerness and cooldown choices while auto-chime is off", () => {
    const v = settingsView();
    const html = form({ view: { ...v, settings: { ...v.settings, chime: { enabled: false, eagerness: "low", cooldownMinutes: 3 } } } });
    expect(html).not.toContain(tx("en", "miniEagerness"));
    expect(html).not.toContain(tx("en", "miniChimeCooldown"));
  });

  it("shows the cooldown choices in minutes, the group's one selected", () => {
    const v = settingsView();
    const html = form({ view: { ...v, settings: { ...v.settings, chime: { enabled: true, eagerness: "low", cooldownMinutes: 10 } } } });
    expect(html).toContain(tx("en", "miniChimeCooldown"));
    expect(html).toMatch(/aria-checked="true"[^>]*>10 min</);
    expect(html).toMatch(/aria-checked="false"[^>]*>0 min</);
    expect(html).toMatch(/aria-checked="false"[^>]*>1 min</);
    expect(html).toMatch(/aria-checked="false"[^>]*>30 min</);
  });

  it("shows the bakery only to the owner", () => {
    expect(form()).not.toContain(tx("en", "miniBakery"));
    const v = settingsView({ isOwner: true, bakeryConfigured: true });
    const html = form({ view: { ...v, settings: { ...v.settings, bakery: true } } });
    expect(html).toContain(tx("en", "miniBakerySwitch"));
    expect(html).not.toContain(tx("en", "miniBakeryNotConfigured"));
    expect(html).toMatch(/role="switch" aria-checked="true"(?![^>]*disabled="")[^>]*>(?:(?!<\/button>).)*Use the bakery/);
  });

  it("disables the bakery switch with a note when the server has no bakery", () => {
    const v = settingsView({ isOwner: true, bakeryConfigured: false });
    const html = form({ view: { ...v, settings: { ...v.settings, bakery: false } } });
    expect(html).toContain(tx("en", "miniBakeryNotConfigured"));
    expect(html).toMatch(/role="switch" aria-checked="false"[^>]*disabled=""/);
  });

  it("shows the save status on the changed section only", () => {
    const saving = form({ status: { state: "saving", section: "memory" } });
    expect(saving.split(tx("en", "miniSaving")).length - 1).toBe(1);
    expect(form({ status: { state: "saved", section: "memory" } })).toContain(tx("en", "miniSaved"));
    expect(form({ status: { state: "error", section: "memory", error: "failed" } })).toContain(tx("en", "miniSaveFailed"));
    expect(form({ status: { state: "error", section: "memory", error: "invalid" } })).toContain(tx("en", "miniErrorInvalid"));
  });

  it("asks for confirmation before forgetting, then reports the outcome", () => {
    expect(form()).not.toContain(tx("en", "miniForgetConfirm"));
    const confirm = form({ forget: { kind: "confirm" } });
    expect(confirm).toContain(tx("en", "miniForgetConfirm"));
    expect(confirm).toContain(tx("en", "miniForgetYes"));
    expect(confirm).toContain(tx("en", "miniCancel"));
    expect(form({ forget: { kind: "done" } })).toContain(tx("en", "miniForgetDone"));
    expect(form({ forget: { kind: "error", error: "failed" } })).toContain(tx("en", "miniForgetFailed"));
    expect(form({ forget: { kind: "error", error: "invalid" } })).toContain(tx("en", "miniErrorInvalid"));
  });
});
