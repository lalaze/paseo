import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { DEFAULT_RUN_TIMEOUT_MS, type LaunchPreferences } from "./launch-model";

const Selection = z
  .object({
    provider: z.string(),
    model: z.string(),
    providerLabel: z.string(),
    modelLabel: z.string(),
  })
  .nullable();
const PreferencesSchema = z.object({
  mode: z.enum(["full", "execute_review"]),
  isolation: z.enum(["local", "worktree"]),
  selections: z.object({ director: Selection, worker: Selection, reviewer: Selection }),
  maxReworks: z.number().int().min(0).max(10),
  // Absent in preferences saved before the time budget became selectable.
  runTimeoutMs: z.number().int().min(3600000).max(86400000).optional(),
});
const PersistedSchema = z.object({ byServer: z.record(z.string(), PreferencesSchema) });
type StoredPreferences = z.infer<typeof PreferencesSchema>;

interface LaunchPreferencesState {
  // Providers and models differ per host, so the last launch is remembered per host.
  byServer: Record<string, StoredPreferences>;
}

export const useCollaborationLaunchPreferences = create<LaunchPreferencesState>()(
  persist(() => ({ byServer: {} }), {
    name: "collaboration-launch-preferences",
    version: 1,
    storage: createValidatedPersistStorage(AsyncStorage, PersistedSchema),
  }),
);

export function rememberedLaunch(serverId: string): LaunchPreferences | undefined {
  const stored = useCollaborationLaunchPreferences.getState().byServer[serverId];
  return stored && { ...stored, runTimeoutMs: stored.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS };
}

export function rememberLaunch(serverId: string, preferences: LaunchPreferences) {
  useCollaborationLaunchPreferences.setState((state) => ({
    byServer: { ...state.byServer, [serverId]: preferences },
  }));
}
