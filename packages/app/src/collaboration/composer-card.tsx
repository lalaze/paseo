import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronUp, Users } from "lucide-react-native";
import { collaborationMode } from "@getpaseo/protocol/collaboration/schema";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { StatusBadge } from "@/components/ui/status-badge";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  collaborationStage,
  composerControl,
  conversationStatus,
  executionModelLabel,
  type Conversation,
} from "./conversation-state";
import { createCollaborationProgressProjection } from "./progress";
import { CollaborationProgressCard } from "./progress-card";
import { findActiveConversation, useCollaboration } from "./use-collaboration";

const ThemedUsers = withUnistyles(Users);
const ThemedChevron = withUnistyles(ChevronUp);
const EMPTY_ITEMS: StreamItem[] = [];
const STAGES = ["plan", "execute", "review", "acceptance"] as const;

/** The live host status stays visible independently of chat pagination and scroll position. */
export function CollaborationComposerCard({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const { query, command, client } = useCollaboration(serverId);
  const conversation = findActiveConversation(query.data, agentId);
  if (!conversation?.run) return null;
  return (
    <ComposerCard
      key={conversation.id}
      serverId={serverId}
      agentId={agentId}
      conversation={conversation}
      error={
        command.error?.message ?? query.error?.message ?? query.data?.error ?? conversation.error
      }
      pending={command.isPending}
      connected={!!client}
      control={command.mutate}
    />
  );
}

function ComposerCard({
  serverId,
  agentId,
  conversation,
  error,
  pending,
  connected,
  control,
}: {
  serverId: string;
  agentId: string;
  conversation: Conversation;
  error?: string | null;
  pending: boolean;
  connected: boolean;
  control: ReturnType<typeof useCollaboration>["command"]["mutate"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const run = conversation.run!;
  const status = conversationStatus(conversation);
  const completed = status.label === "completed" || status.label === "canceled";
  const stage = collaborationStage(run.phase);
  const stages = collaborationMode(conversation) === "full" ? STAGES : STAGES.slice(1);
  const action = composerControl(conversation);
  const act = useCallback(() => {
    if (action) control({ name: "run.control", input: { id: run.id, action } });
  }, [action, control, run.id]);
  let statusLabel = t(`collaboration.history.status.${status.label}`);
  if (conversation.confirmation?.kind === "plan")
    statusLabel = t("collaboration.dock.awaitingPlan");
  if (conversation.confirmation?.kind === "final")
    statusLabel = t("collaboration.history.status.awaitingAcceptance");
  const model = executionModelLabel(conversation);
  const activity = model ? `${model} · ${run.message}` : run.message;
  return (
    <View style={styles.rail}>
      <View style={styles.width}>
        <View style={styles.card} testID="collaboration-composer-card">
          <PressHighlight
            accessibilityRole="button"
            accessibilityLabel={t(
              expanded ? "collaboration.history.collapse" : "collaboration.history.expand",
            )}
            accessibilityState={accessibilityState}
            onPress={toggle}
            style={styles.header}
            testID="collaboration-composer-toggle"
          >
            <ThemedUsers size={16} uniProps={mutedIconColorMapping} />
            <Text style={styles.title}>{t("collaboration.title")}</Text>
            <StatusBadge label={statusLabel} variant={status.variant} size="xs" />
            <Text style={styles.count}>
              {run.done}/{run.total}
            </Text>
            <View style={expanded ? undefined : styles.collapsedChevron}>
              <ThemedChevron size={16} uniProps={mutedIconColorMapping} />
            </View>
          </PressHighlight>
          {!completed || expanded ? (
            <>
              <View style={styles.activity}>
                <Text style={styles.activityText} numberOfLines={1}>
                  {activity}
                </Text>
                {action ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onPress={act}
                    disabled={pending || !connected}
                    loading={pending}
                    testID="collaboration-composer-control"
                  >
                    {t(`collaboration.${action}`)}
                  </Button>
                ) : null}
              </View>
              <View style={styles.stages} testID="collaboration-composer-stages">
                {stages.map((value) => (
                  <View
                    key={value}
                    style={[styles.step, STAGES.indexOf(value) <= stage && styles.reached]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.stepText,
                        STAGES.indexOf(value) === stage && styles.currentStep,
                      ]}
                    >
                      {t(`collaboration.dock.${value}`)}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {error ? (
            <Text
              style={styles.error}
              accessibilityRole="alert"
              testID="collaboration-composer-error"
            >
              {error}
            </Text>
          ) : null}
          {expanded ? (
            <ComposerDetails
              serverId={serverId}
              agentId={agentId}
              conversationId={conversation.id}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Only an open detail pane subscribes to chat items; token streaming cannot repaint the dock. */
function ComposerDetails({
  serverId,
  agentId,
  conversationId,
}: {
  serverId: string;
  agentId: string;
  conversationId: string;
}) {
  const tail =
    useSessionStore((state) => state.sessions[serverId]?.agentStreamTail.get(agentId)) ??
    EMPTY_ITEMS;
  const head =
    useSessionStore((state) => state.sessions[serverId]?.agentStreamHead.get(agentId)) ??
    EMPTY_ITEMS;
  const project = useMemo(() => createCollaborationProgressProjection(), []);
  const projection = useMemo(() => project({ tail, head }), [project, tail, head]);
  const group = [...projection.groupsByHostId.values()].find(
    (entry) => entry.entries[0]?.conversationId === conversationId,
  );
  const [expanded, setExpanded] = useState(false);
  const onExpandedChange = useCallback((_id: string, value: boolean) => setExpanded(value), []);
  if (!group) return null;
  return (
    <ScrollView
      style={styles.details}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      testID="collaboration-composer-details"
    >
      <CollaborationProgressCard
        group={group}
        serverId={serverId}
        agentId={agentId}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
    alignItems: "center",
    flexShrink: 0,
  },
  width: { width: "100%", maxWidth: theme.contentMaxWidth },
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 44,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  count: { marginLeft: "auto", color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  collapsedChevron: { transform: [{ rotate: "180deg" }] },
  activity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  activityText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  stages: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  step: {
    flex: 1,
    borderTopWidth: 2,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1],
  },
  reached: { borderTopColor: theme.colors.accent },
  stepText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  currentStep: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  details: {
    maxHeight: 200,
    flexGrow: 0,
    paddingHorizontal: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));
