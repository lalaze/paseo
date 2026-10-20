import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import type { ReviewProgress } from "@getpaseo/protocol/collaboration/presentation";
import { PressHighlight } from "@/components/ui/press-highlight";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { collaborationFindingsMarkdown } from "./acceptance-markdown";

const ThemedChevron = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function CollaborationReviewHistory({ progress }: { progress: ReviewProgress }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="collaboration-review-history">
      <Text style={styles.heading}>{t("collaboration.report.reviewHistory")}</Text>
      {progress.history.map((round) => (
        <ReviewRound key={round.round} round={round} />
      ))}
    </View>
  );
}

function ReviewRound({ round }: { round: ReviewProgress["history"][number] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const text = useMemo(
    () => collaborationFindingsMarkdown(round.findings ?? [], t),
    [round.findings, t],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const countsKnown = round.added !== undefined && round.recurring !== undefined;
  const key = countsKnown ? "collaboration.report.round" : "collaboration.report.legacyRound";
  const label = t(key, { ...round, decision: t(`collaboration.report.${round.decision}`) });
  if (!text)
    return (
      <Text style={styles.summary} selectable>
        {label}
      </Text>
    );
  return (
    <View>
      <PressHighlight
        testID={`collaboration-review-round-${round.round}`}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.row}
      >
        <Text style={[styles.summary, styles.label]}>{label}</Text>
        <View style={expanded ? styles.expanded : undefined}>
          <ThemedChevron size={16} />
        </View>
      </PressHighlight>
      {expanded ? (
        <View style={styles.details}>
          <MarkdownRenderer text={text} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2], paddingTop: theme.spacing[2] },
  heading: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: theme.spacing[8],
  },
  label: { flex: 1 },
  expanded: { transform: [{ rotate: "90deg" }] },
  details: { paddingVertical: theme.spacing[2] },
}));
