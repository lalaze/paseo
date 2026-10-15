import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { PlanSchema } from "@getpaseo/protocol/collaboration/schema";
import { getPaseoToolLeafName } from "@getpaseo/protocol/tool-name-normalization";

export function collaborationPermissionPlan(
  request: Pick<AgentPermissionRequest, "kind" | "name" | "input">,
) {
  if (request.kind !== "tool") return;
  const tool = getPaseoToolLeafName(request.name) ?? request.name;
  if (tool !== "submit_plan" && tool !== "submit_operation") return;
  const plan = PlanSchema.safeParse(request.input?.payload);
  return plan.success ? plan.data : undefined;
}
