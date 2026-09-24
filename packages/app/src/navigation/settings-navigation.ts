import { router, type Href } from "expo-router";
import { useCollaborationLaunchStore } from "@/collaboration/launch-store";
import { navigateToLastWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  buildOpenProjectRoute,
  buildProjectSettingsRoute,
  buildProjectsSettingsRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "@/utils/host-routes";

export type SettingsView =
  | { kind: "collaboration-history"; serverId: string }
  | { kind: "plugin"; serverId: string; pluginId: string; screenId: string }
  | { kind: "root" }
  | { kind: "wallpapers" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string; projectId: string };

export function openHostOverview(serverId: string): void {
  router.push(buildSettingsHostSectionRoute(serverId, "host"));
}

export function openProjectSettings(serverId: string, projectId: string): void {
  router.push(buildProjectSettingsRoute(serverId, projectId));
}

export function returnFromSettings(view: SettingsView): void {
  const launch = useCollaborationLaunchStore.getState();
  if (
    view.kind === "host" &&
    view.section === "collaboration" &&
    launch.configuring &&
    launch.request?.serverId === view.serverId
  ) {
    router.back();
    return;
  }
  if (view.kind === "root") {
    if (!navigateToLastWorkspace()) {
      router.replace(buildOpenProjectRoute());
    }
    return;
  }

  let parent: Href = buildSettingsRoute();
  if (view.kind === "wallpapers") parent = buildSettingsSectionRoute("appearance");
  if (view.kind === "collaboration-history")
    parent = buildSettingsHostSectionRoute(view.serverId, "collaboration");
  if (view.kind === "plugin") parent = buildSettingsHostSectionRoute(view.serverId, "plugins");
  if (view.kind === "project") parent = buildProjectsSettingsRoute(view.serverId);
  router.dismissTo(parent as Href);
}
