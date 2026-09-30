import { useMemo } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import type { MentionableAgent } from "@/utils/agent-mention";

const NO_AGENTS: MentionableAgent[] = [];

export function useMentionableAgents(
  serverId: string,
  options: { enabled: boolean },
): MentionableAgent[] {
  const supportsDelegation = useHostFeature(serverId, "delegation");
  const providersSnapshot = useProvidersSnapshot(serverId, {
    enabled: options.enabled && supportsDelegation,
  });
  return useMemo(
    () =>
      supportsDelegation
        ? (providersSnapshot.entries ?? [])
            .filter((entry) => entry.enabled)
            .map((entry) => ({ provider: entry.provider, label: entry.label ?? entry.provider }))
        : NO_AGENTS,
    [providersSnapshot.entries, supportsDelegation],
  );
}
