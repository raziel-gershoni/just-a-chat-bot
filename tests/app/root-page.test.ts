import { describe, expect, it } from "vitest";
import RootPage from "@/app/page";
import SettingsPage from "@/app/settings/page";

describe("root page", () => {
  it("serves the settings Mini App, so a Mini App URL set to the bare domain still opens it", () => {
    expect(RootPage).toBe(SettingsPage);
  });
});
