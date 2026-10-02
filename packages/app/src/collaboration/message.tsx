import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react-native";
import type { UserMessageItem } from "@/types/stream";
import { ExpandableBadge } from "@/components/message";
import { collaborationMessageSummary } from "./message-summary";
import { CollaborationConfirmationActions } from "./confirmation-actions";

/** A stage row in the main conversation; the row itself discloses the Agent's instructions. */
export function CollaborationMessage({
  item,
  serverId,
  agentId,
}: {
  item: UserMessageItem;
  serverId: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => collaborationMessageSummary(item), [item]);
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const renderDetails = useCallback(() => {
    if (!summary) return null;
    return (
      <View style={styles.details}>
        {summary.text ? (
          <Text style={styles.summary} selectable>
            {summary.text}
          </Text>
        ) : null}
        {summary.instructions ? (
          <Text style={styles.instructions} selectable>
            {summary.instructions}
          </Text>
        ) : null}
        {summary.acceptance.length ? (
          <View style={styles.acceptance}>
            <Text style={styles.heading}>{t("collaboration.message.acceptanceCriteria")}</Text>
            {summary.acceptance.map((criterion) => (
              <Text key={criterion} style={styles.instructions} selectable>
                {`• ${criterion}`}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    );
  }, [summary, t]);
  if (!summary) return null;
  const noticeId = item.clientMessageId ?? item.messageId;
  const badge = (
    <ExpandableBadge
      testID="collaboration-stage"
      label={t(`collaboration.message.${summary.stage}`)}
      secondaryLabel={summary.text.replace(/\s+/g, " ").trim() || undefined}
      icon={Users}
      isExpanded={expanded}
      onToggle={toggle}
      renderDetails={renderDetails}
      isLastInSequence
      style={styles.row}
    />
  );
  if ((summary.stage !== "approval" && summary.stage !== "acceptance") || !noticeId) return badge;
  return (
    <View>
      {badge}
      <CollaborationConfirmationActions serverId={serverId} agentId={agentId} noticeId={noticeId} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { marginTop: theme.spacing[2] },
  details: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  summary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  instructions: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  acceptance: { gap: theme.spacing[1] },
  heading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
