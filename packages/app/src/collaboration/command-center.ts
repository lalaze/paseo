import { useMemo } from "react";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useCommandCenterActions } from "@/command-center/provider";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { enableCollaboration } from "./launch";

export function useCollaborationCommands(
  serverId: string | null,
  workspaceId: string | null,
  tab: { target: { kind: string; agentId?: string } } | undefined,
) {
  const { t } = useTranslation();
  const agentId = tab?.target.kind === "agent" ? tab.target.agentId : undefined;
  const actions = useMemo<CommandCenterContribution[]>(() => {
    if (!serverId || !workspaceId) return [];
    const entries = [
      {
        id: "settings",
        title: t("collaboration.title"),
        run: () =>
          router.push({
            pathname: "/settings/hosts/[serverId]/[hostSection]",
            params: { serverId, hostSection: "collaboration" },
          }),
      },
      {
        id: "new",
        title: t("collaboration.newConversation"),
        run: () => enableCollaboration({ serverId, workspaceId }),
      },
      ...(agentId
        ? [
            {
              id: "enable",
              title: t("collaboration.enable"),
              run: () => enableCollaboration({ serverId, workspaceId, agentId }),
            },
          ]
        : []),
    ];
    return entries.map((entry, rank) => ({
      id: `collaboration:${entry.id}`,
      group: "collaboration",
      groupRank: 9,
      rank,
      keywords: ["director", "collaboration", "协作"],
      visibility: "query",
      run: entry.run,
      presentation: { kind: "action", title: entry.title },
    }));
  }, [serverId, workspaceId, agentId, t]);
  useCommandCenterActions({
    sourceId: "collaboration",
    enabled: !!serverId && !!workspaceId,
    actions,
  });
}
