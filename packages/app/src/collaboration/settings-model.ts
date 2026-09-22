import { commandLine, parseCommandLine } from "@getpaseo/protocol/collaboration/command-line";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import {
  SettingsSchema,
  type Profile,
  type Settings,
} from "@getpaseo/protocol/collaboration/schema";

type Role = "directorProfileId" | "workerProfileId" | "reviewerProfileId";
const roles: Role[] = ["directorProfileId", "workerProfileId", "reviewerProfileId"];
function profileChoices(initial: Settings | null, profiles: AgentProfile[]): Profile[] {
  const merged = new Map(initial?.profiles.map((profile) => [profile.id, profile]) ?? []);
  for (const profile of profiles) {
    if (!profile.model) continue;
    merged.set(profile.id, {
      ...merged.get(profile.id),
      id: profile.id,
      label: profile.name,
      provider: `${profile.provider}/${profile.model}`,
      modeId: profile.modeId,
      thinkingOptionId: profile.thinkingOptionId,
      featureValues: profile.featureValues,
      transport: "mcp",
    });
  }
  return [...merged.values()];
}
export function openCollaborationSettings(initial: Settings | null, profiles: AgentProfile[]) {
  const choices = profileChoices(initial, profiles);
  const settings = SettingsSchema.parse(
    initial ?? {
      profiles: choices.slice(0, 1),
      directorProfileId: choices[0]?.id,
      workerProfileId: choices[0]?.id,
    },
  );
  const displays: Partial<Record<Role, { label: string }>> = {};
  for (const role of roles) {
    const profile = settings.profiles.find((candidate) => candidate.id === settings[role]);
    if (profile) displays[role] = { label: profile.label };
  }
  let state = {
    ruleKeys: { categoryOverrides: "", taskOverrides: "" },
    settings,
    choices,
    displays,
    checksText: settings.verificationCommands.map(commandLine).join("\n"),
    saving: false,
    saved: false,
    error: "",
  };
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (state.saving) return;
    state = { ...state, error: "", saved: false, settings: { ...state.settings, [key]: value } };
    publish();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applyProfiles(next: AgentProfile[]) {
      state = { ...state, choices: profileChoices(state.settings, next) };
      publish();
    },
    set,
    setRuleKey(kind: "categoryOverrides" | "taskOverrides", key: string) {
      state = { ...state, ruleKeys: { ...state.ruleKeys, [kind]: key } };
      publish();
    },
    addRule(kind: "categoryOverrides" | "taskOverrides") {
      const key = state.ruleKeys[kind].trim();
      if (!key) return;
      set(kind, { ...state.settings[kind], [key]: state.settings.workerProfileId });
    },
    setRule(kind: "categoryOverrides" | "taskOverrides", key: string, profileId: string | null) {
      const rules = { ...state.settings[kind] };
      if (profileId) rules[key] = profileId;
      else delete rules[key];
      set(kind, rules);
    },
    setChecks(text: string) {
      if (state.saving) return;
      state = { ...state, checksText: text, error: "", saved: false };
      publish();
    },
    selectRole(role: Role, id: string) {
      if (state.saving) return;
      const profile = state.choices.find((candidate) => candidate.id === id);
      state = {
        ...state,
        displays: { ...state.displays, [role]: profile ? { label: profile.label } : undefined },
      };
      set(role, id || undefined);
    },
    async save(
      write: (settings: Settings, base: Settings | null) => Promise<void>,
      afterSave?: () => Promise<void>,
    ) {
      if (state.saving) return;
      state = { ...state, saving: true, saved: false, error: "" };
      publish();
      try {
        const selected = new Set([
          ...roles.map((role) => state.settings[role]),
          ...Object.values(state.settings.categoryOverrides),
          ...Object.values(state.settings.taskOverrides),
        ]);
        // Keep legacy custom profiles and their instructions, while native choices remain in the shared profile registry.
        const profilesToSave = new Map(
          state.settings.profiles.map((profile) => [profile.id, profile]),
        );
        for (const profile of state.choices)
          if (selected.has(profile.id)) profilesToSave.set(profile.id, profile);
        const verificationCommands = state.checksText
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const prior = state.settings.verificationCommands.find(
              (check) => commandLine(check) === line,
            );
            return (
              prior ??
              Object.assign(
                { label: line.slice(0, 120), timeoutMs: 120000 },
                parseCommandLine(line),
              )
            );
          });
        const next = SettingsSchema.parse({
          ...state.settings,
          verificationCommands,
          profiles: [...profilesToSave.values()],
        });
        await write(next, initial);
        initial = next;
        state = { ...state, settings: next, saved: true };
        await afterSave?.();
        state = { ...state, saving: false };
      } catch (error) {
        state = {
          ...state,
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      publish();
    },
    close() {
      listeners.clear();
    },
  };
}
