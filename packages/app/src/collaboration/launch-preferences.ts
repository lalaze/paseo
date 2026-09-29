import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { LaunchPreferences } from "./launch-model";

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
});
const PersistedSchema = z.object({ byServer: z.record(z.string(), PreferencesSchema) });

interface LaunchPreferencesState {
  // Providers and models differ per host, so the last launch is remembered per host.
  byServer: Record<string, LaunchPreferences>;
}

export const useCollaborationLaunchPreferences = create<LaunchPreferencesState>()(
  persist(() => ({ byServer: {} }), {
    name: "collaboration-launch-preferences",
    version: 1,
    storage: createValidatedPersistStorage(AsyncStorage, PersistedSchema),
  }),
);

export function rememberedLaunch(serverId: string): LaunchPreferences | undefined {
  return useCollaborationLaunchPreferences.getState().byServer[serverId];
}

export function rememberLaunch(serverId: string, preferences: LaunchPreferences) {
  useCollaborationLaunchPreferences.setState((state) => ({
    byServer: { ...state.byServer, [serverId]: preferences },
  }));
}
