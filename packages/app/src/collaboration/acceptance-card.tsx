import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AcceptanceReport } from "@getpaseo/protocol/collaboration/presentation";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { collaborationAcceptanceMarkdown } from "./acceptance-markdown";

export function CollaborationAcceptanceCard({
  report,
  footer,
  expanded,
}: {
  report: AcceptanceReport;
  footer: ReactNode;
  expanded: boolean;
}) {
  const { t } = useTranslation();
  const text = useMemo(
    () => (expanded ? collaborationAcceptanceMarkdown(report, t) : ""),
    [report, t, expanded],
  );
  const passed = report.review.criteria.filter((criterion) => criterion.passed).length;
  const passedChecks = report.checks.filter((check) => check.exitCode === 0).length;
  const limitations = report.tasks.reduce((count, task) => count + task.issues.length, 0);
  return (
    <View style={styles.container} testID="collaboration-acceptance-report">
      <Text style={styles.summary} numberOfLines={expanded ? undefined : 2} selectable>
        {report.review.summary}
      </Text>
      <View style={styles.metrics} testID="collaboration-acceptance-summary">
        <Text style={styles.metric}>
          {t("collaboration.message.files")} {report.changedFiles.length}
        </Text>
        <Text style={styles.metric}>
          {t("collaboration.message.acceptanceCriteria")} {passed}/{report.review.criteria.length}
        </Text>
        <Text style={styles.metric}>
          {report.checks.length
            ? `${t("collaboration.report.checks")} ${passedChecks}/${report.checks.length}`
            : t("collaboration.report.noHostChecks")}
        </Text>
        {limitations ? (
          <Text style={styles.warning}>
            {t("collaboration.report.limitations")} {limitations}
          </Text>
        ) : null}
        {report.review.findings.length ? (
          <Text style={styles.error}>
            {t("collaboration.report.findings")} {report.review.findings.length}
          </Text>
        ) : null}
      </View>
      {expanded ? (
        <View testID="collaboration-acceptance-details">
          <MarkdownRenderer text={text} />
        </View>
      ) : null}
      {footer}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
  },
  metric: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
