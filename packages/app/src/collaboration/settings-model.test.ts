import { test, expect } from "vitest";
import { SettingsSchema, type Settings } from "@getpaseo/protocol/collaboration/schema";
import { openCollaborationSettings } from "./settings-model";

const profiles = [
  {
    id: "first",
    name: "First",
    provider: "codex",
    model: "gpt-5.4-mini",
    featureValues: { effort: "high" },
  },
];
test("late profiles preserve edits and saved commands keep literal argv", async () => {
  const model = openCollaborationSettings(null, profiles);
  model.set("rolePrompts", { plan: "Read project docs" });
  model.applyProfiles([
    ...profiles,
    { id: "second", name: "Second", provider: "claude", model: "sonnet" },
  ]);
  model.selectRole("workerProfileId", "second");
  model.setChecks("npm run test -- 'path with spaces'\nnode -e 'console.log(1)'");
  let saved: Settings | undefined;
  await model.save(async (settings) => {
    saved = settings;
  });
  expect(model.getState().error).toBe("");
  expect(saved?.rolePrompts).toEqual({ plan: "Read project docs" });
  expect(saved?.workerProfileId).toBe("second");
  expect(saved?.profiles[0].featureValues).toEqual({ effort: "high" });
  expect(saved?.verificationCommands.map(({ command, args }) => ({ command, args }))).toEqual([
    { command: "npm", args: ["run", "test", "--", "path with spaces"] },
    { command: "node", args: ["-e", "console.log(1)"] },
  ]);
  model.close();
});

test("invalid edits and conflicting saves remain editable and do not replace the saved base", async () => {
  const initial = SettingsSchema.parse({
    profiles: [{ id: "first", label: "First", provider: "codex/gpt-5.4-mini" }],
    directorProfileId: "first",
    workerProfileId: "first",
  });
  const model = openCollaborationSettings(initial, profiles);
  model.setChecks("npm test && npm run build");
  let writes = 0;
  await model.save(async () => {
    writes++;
  });
  expect(writes).toBe(0);
  expect(model.getState().error).toContain("each check command separately");
  model.setChecks("npm test");
  model.set("maxReworks", 4);
  await model.save(async () => {
    throw new Error("settings conflict");
  });
  expect(model.getState().error).toBe("settings conflict");
  expect(model.getState().settings.maxReworks).toBe(4);
  await model.save(async (_settings, base) => {
    expect(base).toEqual(initial);
  });
  expect(model.getState().saved).toBe(true);
  model.close();
});

test("successful settings remain the base when launching the conversation fails", async () => {
  const model = openCollaborationSettings(null, profiles);
  let committed: Settings | undefined;
  await model.save(
    async (settings) => {
      committed = settings;
    },
    async () => {
      throw new Error("Disconnected during setup");
    },
  );
  expect(model.getState().error).toBe("Disconnected during setup");
  expect(model.getState().saved).toBe(true);
  await model.save(async (_settings, base) => {
    expect(base).toEqual(committed);
  });
  expect(model.getState().error).toBe("");
  model.close();
});

test("category assignments keep selected profiles and can be removed", async () => {
  const model = openCollaborationSettings(null, profiles);
  model.applyProfiles([
    ...profiles,
    { id: "frontend", name: "Frontend", provider: "claude", model: "sonnet" },
  ]);
  model.setRuleKey("categoryOverrides", "ui");
  model.addRule("categoryOverrides");
  model.setRule("categoryOverrides", "ui", "frontend");
  await model.save(async (settings) => {
    expect(settings.categoryOverrides).toEqual({ ui: "frontend" });
    expect(settings.profiles.map((profile) => profile.id)).toEqual(["first", "frontend"]);
  });
  model.setRule("categoryOverrides", "ui", null);
  expect(model.getState().settings.categoryOverrides).toEqual({});
  model.close();
});
