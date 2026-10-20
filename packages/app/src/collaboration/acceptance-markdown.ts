import type { TFunction } from "i18next";
import type { AcceptanceReport } from "@getpaseo/protocol/collaboration/presentation";
import type { Review } from "@getpaseo/protocol/collaboration/schema";

export function collaborationAcceptanceMarkdown(report: AcceptanceReport, t: TFunction): string {
  const { review } = report;
  const sections = [
    `**${t("collaboration.report.snapshot")}**: ${review.artifactId.slice(0, 12)}`,
    `## ${t("collaboration.message.files")}`,
    bullets(report.changedFiles),
    `## ${t("collaboration.message.acceptanceCriteria")}`,
  ];
  for (const criterion of review.criteria) {
    const status = t(
      criterion.passed ? "collaboration.report.passed" : "collaboration.report.failed",
    );
    sections.push(`**${status}** — ${criterion.criterion}`, criterion.evidence);
  }
  sections.push(`## ${t("collaboration.report.checks")}`);
  if (!report.checks.length) sections.push(t("collaboration.report.noChecks"));
  for (const check of report.checks) {
    let status = t("collaboration.report.incomplete");
    if (check.exitCode === 0) status = t("collaboration.report.passed");
    else if (check.exitCode !== null) status = t("collaboration.report.failed");
    sections.push(`- **${status}** — ${check.label}`);
  }
  if (review.findings.length) sections.push(`## ${t("collaboration.report.findings")}`);
  if (review.findings.length) sections.push(collaborationFindingsMarkdown(review.findings, t));
  if (report.tasks.length) sections.push(`## ${t("collaboration.report.implementation")}`);
  for (const task of report.tasks) {
    sections.push(`### ${task.title}`, task.summary);
    if (task.tests.length)
      sections.push(`**${t("collaboration.report.reportedTests")}**`, bullets(task.tests));
  }
  sections.push(`## ${t("collaboration.report.limitations")}`);
  const issues = report.tasks.flatMap((task) => task.issues);
  sections.push(issues.length ? bullets(issues) : t("collaboration.report.noLimitations"));
  return sections.join("\n\n");
}

export function collaborationFindingsMarkdown(findings: Review["findings"], t: TFunction): string {
  const sections: string[] = [];
  for (const finding of findings) {
    const title = [finding.id, finding.location].filter(Boolean).join(" · ");
    sections.push(
      `### ${title}`,
      finding.problem,
      `**${t("collaboration.report.requiredChange")}**: ${finding.change}`,
      `**${t("collaboration.report.verification")}**: ${finding.verification}`,
    );
  }
  return sections.join("\n\n");
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
