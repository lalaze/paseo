import { create } from "zustand";
import type { CollaborationTarget } from "./launch";

interface LaunchStore {
  request: (CollaborationTarget & { requestId: string }) | null;
  configuring: boolean;
  originPath: string | null;
}

export const useCollaborationLaunchStore = create<LaunchStore>(() => ({
  request: null,
  configuring: false,
  originPath: null,
}));

export function closeCollaborationLaunch() {
  useCollaborationLaunchStore.setState({ request: null, configuring: false, originPath: null });
}
