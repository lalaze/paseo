import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, Users } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { CollaborationMessage, CollaborationMessageControls } from "./message";
import { CollaborationHandoffAction } from "./execution-switch-sheet";
import type { CollaborationProgressGroup } from "./progress";

const ThemedUsers = withUnistyles(Users, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedChevron = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function CollaborationProgressCard({
  group,
  expanded,
  onExpandedChange,
  serverId,
  agentId,
}: {
  group: CollaborationProgressGroup;
  expanded: boolean;
  onExpandedChange: (id: string, expanded: boolean) => void;
  serverId: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(
    () => onExpandedChange(group.id, !expanded),
    [onExpandedChange, group.id, expanded],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const latest = group.entries[group.entries.length - 1]!;
  return (
    <View style={styles.card} testID="collaboration-progress-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("collaboration.message.progressTitle")}
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.header}
        testID="collaboration-progress-toggle"
      >
        <ThemedUsers size={16} />
        <Text style={styles.title}>{t("collaboration.message.progressTitle")}</Text>
        <Text style={styles.count}>
          {t("collaboration.message.updates", { count: group.entries.length })}
        </Text>
        <View style={expanded ? styles.chevronExpanded : undefined}>
          <ThemedChevron size={16} />
        </View>
      </Pressable>
      <View style={styles.current} testID="collaboration-progress-current">
        <Text style={styles.stage}>{t(`collaboration.message.${latest.summary.stage}`)}</Text>
        {latest.summary.text ? (
          <Text style={styles.summary} selectable>
            {latest.summary.text}
          </Text>
        ) : null}
      </View>
      {expanded ? (
        <View style={styles.history} testID="collaboration-progress-history">
          {group.entries.map(({ item }) => (
            <CollaborationMessage
              key={item.id}
              item={item}
              serverId={serverId}
              agentId={agentId}
              showControls={false}
            />
          ))}
        </View>
      ) : null}
      {group.entries.map(({ item }) => (
        <CollaborationMessageControls
          key={item.id}
          item={item}
          serverId={serverId}
          agentId={agentId}
          showHandoff={false}
        />
      ))}
      <CollaborationHandoffAction
        serverId={serverId}
        agentId={agentId}
        execution={latest.summary.execution}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    gap: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: theme.spacing[6],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  current: { gap: theme.spacing[1] },
  stage: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  history: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
  },
}));
