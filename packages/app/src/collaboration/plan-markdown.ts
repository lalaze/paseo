import type { Plan } from "@getpaseo/protocol/collaboration/schema";

interface PlanLabels {
  architecture: string;
  acceptanceCriteria: string;
  tasks: string;
  files: string;
  dependsOn: string;
}

export function collaborationPlanMarkdown(plan: Plan, labels: PlanLabels): string {
  const sections = [
    plan.summary,
    `## ${labels.architecture}\n\n${plan.architecture}`,
    `## ${labels.acceptanceCriteria}\n\n${bullets(plan.acceptance)}`,
    `## ${labels.tasks}`,
  ];
  for (const task of plan.tasks) {
    sections.push(
      `### ${task.title}`,
      task.description,
      `**${labels.files}**\n\n${bullets(task.files)}`,
      `**${labels.acceptanceCriteria}**\n\n${bullets(task.acceptance)}`,
    );
    if (task.dependsOn.length) {
      const dependencies = task.dependsOn.map((id) => {
        const dependency = plan.tasks.find((candidate) => candidate.id === id);
        return dependency ? dependency.title : id;
      });
      sections.push(`**${labels.dependsOn}**\n\n${bullets(dependencies)}`);
    }
  }
  return sections.join("\n\n");
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
