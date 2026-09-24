import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react-native";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { enableCollaboration } from "./launch";

interface CollaborationControlProps {
  serverId: string;
  workspaceId: string;
  agentId?: string;
}

export function CollaborationControl({
  serverId,
  workspaceId,
  agentId,
}: CollaborationControlProps) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    void enableCollaboration({ serverId, workspaceId, agentId });
  }, [serverId, workspaceId, agentId]);
  return (
    <AgentControlTrigger
      icon={Users}
      surface="toolbar"
      label={t("collaboration.title")}
      accessibilityLabel={t("collaboration.chooseMode")}
      onPress={open}
      testID="composer-collaboration"
    />
  );
}
