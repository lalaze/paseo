import { describe, expect, it } from "vitest";
import { SettingsSchema } from "./schema.js";
import { SettingsDraftSchema, formChanged, settingsForm } from "./settings-draft.js";

const settings = SettingsSchema.parse({
  profiles: [
    { id: "worker", label: "Worker", provider: "codex/gpt-5" },
    { id: "reviewer", label: "Reviewer", provider: "claude/opus" },
  ],
  directorProfileId: "reviewer",
  workerProfileId: "worker",
  reviewerProfileId: "reviewer",
  reviewerAsLead: true,
  executionFallbacks: { worker: [{ provider: "codex/gpt-5-mini", thinkingOptionId: "high" }] },
});

describe("settings drafts", () => {
  it("parses a draft saved before execution fallbacks existed", () => {
    const form = settingsForm(null);
    expect(form).not.toHaveProperty("executionFallbacks");
    expect(SettingsDraftSchema.parse({ version: 1, base: null, form }).form).toEqual(form);
    expect(formChanged(form, null)).toBe(false);
  });

  it("round-trips execution fallbacks so a later draft save keeps them", () => {
    const form = settingsForm(settings);
    expect(form.executionFallbacks).toEqual({
      worker: [{ provider: "codex/gpt-5-mini", thinkingOptionId: "high" }],
    });
    expect(formChanged(form, settings)).toBe(false);
    const draft = SettingsDraftSchema.parse({ version: 1, base: settings, form });
    expect(draft.form.executionFallbacks).toEqual(settings.executionFallbacks);
  });
});
