import type { SettingsView } from "@/src/miniapp/service";

export function settingsView(over: Partial<SettingsView> = {}): SettingsView {
  return {
    groupTitle: "Family",
    settings: {
      model: "claude-opus-5-5",
      effort: "medium",
      chime: { enabled: true, eagerness: "low", cooldownMinutes: 3 },
      triggerEmoji: "👾",
      historyWindow: 100,
      language: "en",
    },
    models: [
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", maxTokens: 32000, efforts: ["low", "medium", "high", "xhigh", "max"], adaptive: true },
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", maxTokens: 32000, efforts: ["low", "medium", "high"], adaptive: true },
    ],
    emojis: ["👍", "👾", "🔥"],
    isOwner: false,
    bakeryConfigured: false,
    ...over,
  };
}
