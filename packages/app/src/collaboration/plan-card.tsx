import { useMemo, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import type { Plan } from "@getpaseo/protocol/collaboration/schema";
import { PlanCard } from "@/components/plan-card";
import { collaborationPlanMarkdown } from "./plan-markdown";

interface CollaborationPlanCardProps extends Omit<ComponentProps<typeof PlanCard>, "text"> {
  plan: Plan;
}

export function CollaborationPlanCard({ plan, ...props }: CollaborationPlanCardProps) {
  const { t } = useTranslation();
  const text = useMemo(
    () =>
      collaborationPlanMarkdown(plan, {
        architecture: t("collaboration.message.architecture"),
        acceptanceCriteria: t("collaboration.message.acceptanceCriteria"),
        tasks: t("collaboration.message.tasks"),
        files: t("collaboration.message.files"),
        dependsOn: t("collaboration.message.dependsOn"),
      }),
    [plan, t],
  );
  return <PlanCard {...props} text={text} />;
}
