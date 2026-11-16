"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  Cpu,
  Croissant,
  Eraser,
  History,
  Languages,
  Link2Off,
  LoaderCircle,
  MessagesSquare,
  SmilePlus,
  UserX,
} from "lucide-react";
import { LANG_NAMES, pickLang, t, type Lang, type MsgKey } from "@/src/i18n";
import type { SettingsView } from "@/src/miniapp/service";
import type { GroupSettings } from "@/src/settings/schema";
import { CHIME_COOLDOWNS } from "@/src/settings/cooldowns";
import { HISTORY_WINDOWS } from "@/src/settings/windows";
import {
  bootstrap,
  createSaveQueue,
  forgetHistory,
  saveSettings,
  type ApiError,
  type SaveQueue,
  type SaveStatus,
  type SectionId,
  type SettingsPatch,
} from "./client";

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { user?: { language_code?: string } };
  ready(): void;
  expand(): void;
};
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
type Effort = GroupSettings["effort"];
type Eagerness = GroupSettings["chime"]["eagerness"];
export type ForgetState = { kind: "idle" | "confirm" | "working" | "done" } | { kind: "error"; error: ApiError };

// Records keyed by the settings types, so a new effort or eagerness level fails the typecheck until labelled.
const EFFORT_LABELS = {
  low: "miniEffortLow",
  medium: "miniEffortMedium",
  high: "miniEffortHigh",
  xhigh: "miniEffortXhigh",
  max: "miniEffortMax",
} as const satisfies Record<Effort, MsgKey>;
const EAGERNESS_LABELS = {
  low: "miniEagernessLow",
  medium: "miniEagernessMedium",
  high: "miniEagernessHigh",
} as const satisfies Record<Eagerness, MsgKey>;
const isEffort = (e: string): e is Effort => Object.hasOwn(EFFORT_LABELS, e);
// "3 min" / "3 דק׳" / "3 мин", in the reader's language.
const minutes = (lang: Lang, n: number) =>
  new Intl.NumberFormat(lang, { style: "unit", unit: "minute", unitDisplay: "short" }).format(n);

const ERROR_TEXT: Record<ApiError, MsgKey> = {
  invalid: "miniErrorInvalid",
  unknown_group: "miniErrorUnknownGroup",
  not_member: "miniErrorNotMember",
  failed: "miniErrorFailed",
};
const ERROR_ICON: Record<ApiError, Icon> = { invalid: Clock, unknown_group: Link2Off, not_member: UserX, failed: CircleAlert };

const dirOf = (lang: Lang) => (lang === "he" ? "rtl" : "ltr");

function Shell({ lang, busy, children }: { lang: Lang | null; busy?: boolean; children: ReactNode }) {
  return (
    <main
      lang={lang ?? undefined}
      dir={lang ? dirOf(lang) : undefined}
      aria-busy={busy || undefined}
      className="mx-auto w-full max-w-lg px-4 pt-6 pb-[max(2.5rem,env(safe-area-inset-bottom))]"
    >
      {children}
    </main>
  );
}

export function LoadingScreen({ lang }: { lang: Lang | null }) {
  return (
    <Shell lang={lang} busy>
      {lang && <p role="status" className="sr-only">{t(lang, "miniLoading")}</p>}
      <div aria-hidden className="space-y-7">
        <div className="space-y-2">
          <div className="skeleton-shimmer h-8 w-2/3 rounded-xl" />
          <div className="skeleton-shimmer h-4 w-1/2 rounded-lg" />
        </div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-3">
            <div className="skeleton-shimmer h-5 w-1/3 rounded-lg" />
            <div className="skeleton-shimmer h-12 rounded-2xl" />
          </div>
        ))}
      </div>
    </Shell>
  );
}

export function ErrorScreen({ lang, error }: { lang: Lang; error: ApiError }) {
  const ErrorIcon = ERROR_ICON[error];
  return (
    <Shell lang={lang}>
      <div role="alert" className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-tg-secondary-bg">
          <ErrorIcon className="size-7 text-tg-hint" aria-hidden />
        </span>
        <p className="max-w-xs text-[17px] leading-snug text-balance">{t(lang, ERROR_TEXT[error])}</p>
      </div>
    </Shell>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-sm leading-snug text-tg-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

// The live region is always there, so screen readers announce "Saving…" and "Saved" as they change.
function StatusBadge({ lang, status }: { lang: Lang; status: SaveStatus | null }) {
  return (
    <span role="status" className="ms-auto shrink-0 text-[13px] text-tg-hint">
      {status?.state === "saving" && (
        <span className="flex items-center gap-1">
          <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
          {t(lang, "miniSaving")}
        </span>
      )}
      {status?.state === "saved" && (
        <span className="fade-out-late flex items-center gap-1">
          <Check className="size-3.5" aria-hidden />
          {t(lang, "miniSaved")}
        </span>
      )}
    </span>
  );
}

function Section(props: {
  id: SectionId;
  icon: Icon;
  title: string;
  hint?: string;
  lang: Lang;
  status: SaveStatus | null;
  children: ReactNode;
}) {
  const { id, icon: SectionIcon, title, hint, lang, children } = props;
  const status = props.status?.section === id ? props.status : null;
  return (
    <section aria-labelledby={`section-${id}`} className="border-t border-separator py-5">
      <div className="flex min-h-6 items-center gap-2">
        <SectionIcon className="size-[18px] shrink-0 text-tg-hint" aria-hidden />
        <h2 id={`section-${id}`} className="min-w-0 text-[15px] font-semibold tracking-tight">{title}</h2>
        <StatusBadge lang={lang} status={status} />
      </div>
      {hint ? <p className="mt-1 mb-3 text-sm leading-snug text-tg-hint">{hint}</p> : <div className="h-3" />}
      {children}
      {status?.state === "error" && (
        <ErrorLine text={t(lang, status.error === "failed" ? "miniSaveFailed" : ERROR_TEXT[status.error])} />
      )}
    </section>
  );
}

function Segmented<T extends string | number>(props: {
  label: string;
  options: { value: T; text: string }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-2xl bg-tg-secondary-bg p-1">
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => on || props.onSelect(o.value)}
            className={`min-h-10 min-w-0 rounded-xl px-0.5 py-2 text-[13px] leading-tight font-semibold tracking-tight break-words ${
              on ? "bg-tg-button text-tg-button-text shadow-sm" : "text-tg-hint active:bg-tg-bg/60"
            }`}
          >
            {o.text}
          </button>
        );
      })}
    </div>
  );
}

// The whole row is the switch (44px+ target); the knob moves the right way in RTL. From just-a-list-manager.
function SwitchRow(props: { label: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  const { label, checked, disabled, onToggle } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-2xl bg-tg-secondary-bg px-4 py-3 text-start text-[15px] font-medium active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
    >
      <span className="min-w-0">{label}</span>
      <span
        aria-hidden
        className={`relative inline-flex h-7 w-12 shrink-0 rounded-full motion-safe:transition-colors ${checked ? "bg-tg-button" : "bg-tg-hint/40"}`}
      >
        <span
          className={`absolute start-0.5 top-0.5 size-6 rounded-full shadow-sm motion-safe:transition-transform ${
            checked ? "translate-x-5 bg-tg-button-text rtl:-translate-x-5" : "bg-white"
          }`}
        />
      </span>
    </button>
  );
}

export type FormProps = {
  lang: Lang;
  view: SettingsView;
  status: SaveStatus | null;
  forget: ForgetState;
  onChange: (section: SectionId, patch: SettingsPatch) => void;
  onForget: (action: "start" | "cancel" | "confirm") => void;
};

export function SettingsForm({ lang, view, status, forget, onChange, onForget }: FormProps) {
  const s = view.settings;
  const model = view.models.find((m) => m.id === s.model);
  const efforts = (model?.efforts ?? []).filter(isEffort);
  const section = { lang, status };
  const confirming = forget.kind === "confirm" || forget.kind === "working";

  return (
    <Shell lang={lang}>
      <header className="pb-5">
        <h1 className="text-[26px] leading-tight font-bold tracking-tight break-words">{view.groupTitle}</h1>
        <p className="mt-1 text-sm text-tg-hint">{t(lang, "miniSubtitle")}</p>
      </header>

      <Section id="model" icon={Cpu} title={t(lang, "miniModel")} {...section}>
        <div className="relative">
          <select
            aria-label={t(lang, "miniModel")}
            value={s.model}
            onChange={(e) => onChange("model", { model: e.target.value })}
            className="w-full appearance-none rounded-2xl bg-tg-secondary-bg py-3 ps-4 pe-11 text-base font-medium text-tg-text"
          >
            {!model && <option value={s.model}>{s.model}</option>}
            {view.models.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute end-4 top-1/2 size-5 -translate-y-1/2 text-tg-hint" aria-hidden />
        </div>
      </Section>

      {efforts.length > 0 && (
        <Section id="effort" icon={Brain} title={t(lang, "miniEffort")} hint={t(lang, "miniEffortHint")} {...section}>
          <Segmented
            label={t(lang, "miniEffort")}
            options={efforts.map((e) => ({ value: e, text: t(lang, EFFORT_LABELS[e]) }))}
            value={s.effort}
            onSelect={(effort) => onChange("effort", { effort })}
          />
        </Section>
      )}

      <Section id="chime" icon={MessagesSquare} title={t(lang, "miniChime")} {...section}>
        <SwitchRow
          label={t(lang, "miniChimeSwitch")}
          checked={s.chime.enabled}
          onToggle={() => onChange("chime", { chime: { enabled: !s.chime.enabled } })}
        />
        {s.chime.enabled && (
          <div className="mt-4">
            <p className="mb-2 text-sm text-tg-hint">{t(lang, "miniEagerness")}</p>
            <Segmented
              label={t(lang, "miniEagerness")}
              options={(Object.keys(EAGERNESS_LABELS) as Eagerness[]).map((e) => ({ value: e, text: t(lang, EAGERNESS_LABELS[e]) }))}
              value={s.chime.eagerness}
              onSelect={(eagerness) => onChange("chime", { chime: { eagerness } })}
            />
            <p className="mt-4 mb-2 text-sm text-tg-hint">{t(lang, "miniChimeCooldown")}</p>
            <Segmented
              label={t(lang, "miniChimeCooldown")}
              options={CHIME_COOLDOWNS.map((n) => ({ value: n as number, text: minutes(lang, n) }))}
              value={s.chime.cooldownMinutes}
              onSelect={(cooldownMinutes) => onChange("chime", { chime: { cooldownMinutes } })}
            />
          </div>
        )}
      </Section>

      <Section id="trigger" icon={SmilePlus} title={t(lang, "miniTrigger")} hint={t(lang, "miniTriggerHint")} {...section}>
        <div role="radiogroup" aria-label={t(lang, "miniTrigger")} className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1">
          {view.emojis.map((e) => {
            const on = e === s.triggerEmoji;
            return (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => on || onChange("trigger", { triggerEmoji: e })}
                className={`emoji grid h-11 place-items-center rounded-xl text-[26px] leading-none ${
                  on ? "bg-tg-active/15 ring-2 ring-tg-active" : "active:bg-tg-secondary-bg"
                }`}
              >{e}</button>
            );
          })}
        </div>
      </Section>

      <Section id="language" icon={Languages} title={t(lang, "miniLanguage")} hint={t(lang, "miniLanguageHint")} {...section}>
        <Segmented
          label={t(lang, "miniLanguage")}
          options={(Object.keys(LANG_NAMES) as Lang[]).map((l) => ({ value: l, text: LANG_NAMES[l] }))}
          value={s.language}
          onSelect={(language) => onChange("language", { language })}
        />
      </Section>

      <Section id="memory" icon={History} title={t(lang, "miniMemory")} hint={t(lang, "miniMemoryHint")} {...section}>
        <Segmented
          label={t(lang, "miniMemory")}
          options={HISTORY_WINDOWS.map((n) => ({ value: n as number, text: String(n) }))}
          value={s.historyWindow}
          onSelect={(historyWindow) => onChange("memory", { historyWindow })}
        />
      </Section>

      {view.isOwner && (
        <Section id="bakery" icon={Croissant} title={t(lang, "miniBakery")} hint={t(lang, "miniBakeryHint")} {...section}>
          <SwitchRow
            label={t(lang, "miniBakerySwitch")}
            checked={s.bakery ?? false}
            disabled={!view.bakeryConfigured}
            onToggle={() => onChange("bakery", { bakery: !s.bakery })}
          />
          {!view.bakeryConfigured && <p className="mt-2 text-sm leading-snug text-tg-hint">{t(lang, "miniBakeryNotConfigured")}</p>}
        </Section>
      )}

      <section className="border-t border-separator pt-5">
        <p className="mb-3 text-sm leading-snug text-tg-hint">{t(lang, "miniForgetHint")}</p>
        {confirming ? (
          <div className="reveal rounded-2xl border border-tg-destructive/30 bg-tg-destructive/10 p-4">
            <p className="mb-3 text-[15px] leading-snug">{t(lang, "miniForgetConfirm")}</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={forget.kind === "working"}
                onClick={() => onForget("cancel")}
                className="min-h-11 rounded-xl bg-tg-secondary-bg font-medium disabled:opacity-50"
              >
                {t(lang, "miniCancel")}
              </button>
              <button
                type="button"
                disabled={forget.kind === "working"}
                onClick={() => onForget("confirm")}
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-tg-destructive px-2 font-semibold text-tg-destructive-text disabled:opacity-70"
              >
                {forget.kind === "working" && <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />}
                {t(lang, "miniForgetYes")}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onForget("start")}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-tg-secondary-bg px-4 py-3 font-medium text-tg-destructive active:scale-[0.98]"
          >
            <Eraser className="size-[18px]" aria-hidden />
            {t(lang, "miniForget")}
          </button>
        )}
        {forget.kind === "done" && (
          <p role="status" className="mt-2 flex items-start gap-1.5 text-sm leading-snug text-tg-hint">
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t(lang, "miniForgetDone")}</span>
          </p>
        )}
        {forget.kind === "error" && (
          <ErrorLine text={t(lang, forget.error === "failed" ? "miniForgetFailed" : ERROR_TEXT[forget.error])} />
        )}
      </section>
    </Shell>
  );
}

type Phase = { kind: "loading" } | { kind: "error"; error: ApiError } | { kind: "ready"; view: SettingsView };
type Session = { token: string; queue: SaveQueue; fetchFn: typeof fetch };

export default function SettingsApp() {
  const [lang, setLang] = useState<Lang | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [status, setStatus] = useState<SaveStatus | null>(null);
  const [forget, setForget] = useState<ForgetState>({ kind: "idle" });
  const session = useRef<Session | null>(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
    } else {
      console.warn("[settings] Telegram WebApp script is missing");
    }
    setLang(pickLang(tg?.initDataUnsafe?.user?.language_code));
    const fetchFn = window.fetch.bind(window);
    let live = true;
    bootstrap(fetchFn, tg?.initData ?? "")
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setPhase({ kind: "error", error: r.error });
          return;
        }
        const { token, view } = r.data;
        const queue = createSaveQueue({
          initial: view,
          put: (patch) => saveSettings(fetchFn, token, patch),
          onUpdate: (next, st) => {
            setPhase({ kind: "ready", view: next });
            setStatus(st);
          },
        });
        session.current = { token, queue, fetchFn };
        setPhase({ kind: "ready", view });
      })
      .catch((err) => {
        console.error("[settings] startup failed", err);
        if (live) setPhase({ kind: "error", error: "failed" });
      });
    return () => {
      live = false;
    };
  }, []);

  function change(section: SectionId, patch: SettingsPatch) {
    if (!session.current) {
      console.error("[settings] change before the session started", section);
      return;
    }
    void session.current.queue.change(section, patch);
  }

  function onForget(action: "start" | "cancel" | "confirm") {
    if (action !== "confirm") {
      setForget({ kind: action === "start" ? "confirm" : "idle" });
      return;
    }
    const s = session.current;
    if (!s) {
      console.error("[settings] forget before the session started");
      return;
    }
    setForget({ kind: "working" });
    void forgetHistory(s.fetchFn, s.token).then((r) => setForget(r.ok ? { kind: "done" } : { kind: "error", error: r.error }));
  }

  if (lang && phase.kind === "error") return <ErrorScreen lang={lang} error={phase.error} />;
  if (lang && phase.kind === "ready") {
    return <SettingsForm lang={lang} view={phase.view} status={status} forget={forget} onChange={change} onForget={onForget} />;
  }
  return <LoadingScreen lang={lang} />;
}
