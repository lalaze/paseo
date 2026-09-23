import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CircleAlert, Ellipsis } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { collaborationMode } from "@getpaseo/protocol/collaboration/schema";
import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type DropdownMenuTriggerProps,
} from "@/components/ui/dropdown-menu";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import type { CollaborationCommandInput } from "./use-collaboration";
type Conversation = CollaborationState["conversations"][number];
type Control = "pause" | "resume" | "retry" | "cancel";
interface HistoryProps {
  serverId: string;
  conversations: Conversation[];
  pending: boolean;
  command: (input: CollaborationCommandInput) => void;
}

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedAlert = withUnistyles(CircleAlert);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerColor = (theme: Theme) => ({ color: theme.colors.statusDanger });
const menuTriggerStyle: DropdownMenuTriggerProps["style"] = ({ pressed, hovered, open }) => [
  styles.menuTrigger,
  (pressed || hovered || open) && styles.menuTriggerActive,
];

export function ConversationHistory({ conversations, ...props }: HistoryProps) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card} testID="collaboration-history">
      {conversations.length ? (
        conversations.map((conversation, index) => (
          <ConversationRow
            key={conversation.id}
            {...props}
            conversation={conversation}
            first={index === 0}
          />
        ))
      ) : (
        <View style={styles.row}>
          <Text style={styles.secondary}>{t("collaboration.empty")}</Text>
        </View>
      )}
    </View>
  );
}

function ConversationRow({
  serverId,
  conversation,
  first,
  pending,
  command,
}: Omit<HistoryProps, "conversations"> & { conversation: Conversation; first: boolean }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [expanded, setExpanded] = useState(false);
  const toggleDetails = useCallback(() => setExpanded((value) => !value), []);
  const rowStyle = useMemo(() => [styles.row, !first && settingsStyles.rowBorder], [first]);
  const open = useCallback(() => {
    if (conversation.agentId)
      navigateToAgent({
        serverId,
        workspaceId: conversation.workspaceId,
        agentId: conversation.agentId,
      });
  }, [serverId, conversation.workspaceId, conversation.agentId]);
  const resync = useCallback(
    () => command({ name: "conversation.resync", input: { id: conversation.id } }),
    [command, conversation.id],
  );
  const run = conversation.run;
  const status = conversationStatus(conversation);
  const actions = availableControls(run);
  return (
    <View style={rowStyle} testID={`collaboration-history-${conversation.id}`}>
      <View style={styles.metadata}>
        <StatusBadge
          label={t(`collaboration.history.status.${status.label}`)}
          variant={status.variant}
        />
        <Text style={styles.secondary}>
          {t(`collaboration.modes.${collaborationMode(conversation)}`)}
        </Text>
        {run && run.total > 0 && (
          <Text style={styles.secondary}>
            {t("collaboration.history.progress", { done: run.done, total: run.total })}
          </Text>
        )}
      </View>
      <Text
        style={styles.title}
        numberOfLines={expanded ? undefined : 2}
        testID="collaboration-history-title"
      >
        {conversation.title}
      </Text>
      {run?.message && (
        <Text style={styles.secondary} numberOfLines={expanded ? undefined : 1}>
          {run.message}
        </Text>
      )}
      {conversation.error && (
        <View style={styles.errorRow}>
          <ThemedAlert size={ICON_SIZE.sm} uniProps={dangerColor} />
          <Text style={styles.error} numberOfLines={expanded ? undefined : 2}>
            {conversation.error}
          </Text>
        </View>
      )}
      <View style={styles.footer}>
        {conversation.agentId ? (
          <Button onPress={open} variant="outline" size={compact ? "md" : "sm"}>
            {t("collaboration.open")}
          </Button>
        ) : (
          <View />
        )}
        <DropdownMenu compactMode="sheet">
          <DropdownMenuTrigger
            style={menuTriggerStyle}
            accessibilityRole="button"
            accessibilityLabel={t("collaboration.history.actions")}
            testID="collaboration-history-actions"
          >
            <ThemedEllipsis size={ICON_SIZE.md} uniProps={mutedColor} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={240}>
            <DropdownMenuItem onSelect={toggleDetails}>
              {t(expanded ? "collaboration.history.collapse" : "collaboration.history.expand")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={resync} disabled={pending}>
              {t("collaboration.resync")}
            </DropdownMenuItem>
            {run && actions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {actions.map((action) => (
                  <RunAction
                    key={action}
                    action={action}
                    id={run.id}
                    pending={pending}
                    command={command}
                  />
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

function conversationStatus({ run, error }: Conversation): {
  label: string;
  variant: StatusBadgeVariant;
} {
  if (run?.control === "canceled") return { label: "canceled", variant: "muted" };
  if (run?.control === "canceling") return { label: "canceling", variant: "muted" };
  if (run?.phase === "completed") return { label: "completed", variant: "success" };
  if (error || run?.control === "needs_attention")
    return { label: "needsAttention", variant: "error" };
  if (run?.control === "paused") return { label: "paused", variant: "warning" };
  if (run?.control === "waiting_permission")
    return { label: "waitingPermission", variant: "warning" };
  if (run?.phase === "awaiting_acceptance")
    return { label: "awaitingAcceptance", variant: "warning" };
  return { label: run ? "running" : "ready", variant: "muted" };
}

function availableControls(run: Conversation["run"]): Control[] {
  if (!run || run.phase === "completed" || run.control === "canceled") return [];
  if (run.phase === "awaiting_acceptance") return ["cancel"];
  if (run.control === "paused") return ["resume", "cancel"];
  if (run.control === "needs_attention") return ["retry", "cancel"];
  if (run.control === "canceling") return [];
  return ["pause", "cancel"];
}

function RunAction({
  action,
  id,
  pending,
  command,
}: {
  action: Control;
  id: string;
  pending: boolean;
  command: HistoryProps["command"];
}) {
  const { t } = useTranslation();
  const select = useCallback(
    () => command({ name: "run.control", input: { id, action } }),
    [command, id, action],
  );
  return (
    <DropdownMenuItem disabled={pending} onSelect={select} destructive={action === "cancel"}>
      {t(`collaboration.${action}`)}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { padding: theme.spacing[4], gap: theme.spacing[3] },
  metadata: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 22 },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  errorRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  error: { flex: 1, color: theme.colors.statusDanger, fontSize: theme.fontSize.sm, lineHeight: 20 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  menuTrigger: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  menuTriggerActive: { backgroundColor: theme.colors.surface2 },
}));
