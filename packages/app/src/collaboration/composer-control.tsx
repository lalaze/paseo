import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Users } from "lucide-react-native";
import { randomUUID } from "expo-crypto";
import { collaborationMode, type CollaborationMode } from "@getpaseo/protocol/collaboration/schema";
import type { CollaborationState } from "@getpaseo/protocol/collaboration/rpc";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentControlIconProps } from "@/agent-controls/icons";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { providersSnapshotQueryKey, useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature, useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import {
  beginCollaborationEnable,
  collaborationEnableKey,
  isCollaborationEnablePending,
  selectCollaborationEnabling,
  selectCollaborationError,
  selectCollaborationRequest,
  settleCollaborationEnable,
  useCollaborationEnableStore,
} from "./enable-store";
import { enableCollaboration } from "./launch";
import { resolveQuickLaunch } from "./launch-quick";
import { rememberedLaunch } from "./launch-preferences";
import { buildModelSelection, type ModelSelection } from "./launch-model";
import { collaborationQueryKey, useCollaboration } from "./use-collaboration";

interface CollaborationControlProps {
  serverId: string;
  workspaceId: string;
  /** The conversation to take over; absent for a draft, which starts a new one. */
  agentId?: string;
  /** The composer's own agent/tab id, so its send is blocked while an enable is in flight. */
  keyAgentId: string;
  /** The draft's chosen model, inherited when there is no live conversation yet. */
  draftModel?: ModelSelection | null;
}

function PendingGlyph({ size, color }: AgentControlIconProps) {
  return <LoadingSpinner size={size} color={color} />;
}

export function CollaborationControl({
  serverId,
  workspaceId,
  agentId,
  keyAgentId,
  draftModel,
}: CollaborationControlProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { query, supportsInlineModels } = useCollaboration(serverId);
  const refetch = query.refetch;
  const supportsExecuteReview = useHostFeature(serverId, "collaborationExecuteReview");
  const supportsWorktree =
    useHostFeatureAvailabilityMap([serverId], "collaborationWorktree").get(serverId) === true;
  const cwd = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  // Keeps the catalog query active for this cwd so the quick path can await a real fetch.
  useProvidersSnapshot(serverId, { cwd });
  const key = collaborationEnableKey(serverId, keyAgentId);
  const pending = useCollaborationEnableStore((state) => selectCollaborationEnabling(state, key));
  const error = useCollaborationEnableStore((state) => selectCollaborationError(state, key));

  const agentProvider = useSessionStore((state) =>
    agentId ? (state.sessions[serverId]?.agents?.get(agentId)?.provider ?? null) : null,
  );
  const agentModelId = useSessionStore((state) => {
    if (!agentId) return null;
    const agent = state.sessions[serverId]?.agents?.get(agentId);
    return agent?.model ?? agent?.runtimeInfo?.model ?? null;
  });
  const agentThinkingOptionId = useSessionStore((state) => {
    if (!agentId) return null;
    const agent = state.sessions[serverId]?.agents?.get(agentId);
    return agent?.thinkingOptionId ?? agent?.runtimeInfo?.thinkingOptionId ?? null;
  });
  const currentModel = useMemo<ModelSelection | null>(() => {
    if (agentProvider && agentModelId) {
      return buildModelSelection(agentProvider, agentModelId, agentThinkingOptionId);
    }
    return draftModel ?? null;
  }, [agentProvider, agentModelId, agentThinkingOptionId, draftModel]);

  const conversation = useMemo(
    () =>
      agentId ? query.data?.conversations.find((entry) => entry.agentId === agentId) : undefined,
    [agentId, query.data],
  );
  const enabled = Boolean(conversation);

  const openConfig = useCallback(() => {
    void enableCollaboration({
      serverId,
      workspaceId,
      agentId,
      keyAgentId,
      edit: true,
      currentModel,
    });
  }, [serverId, workspaceId, agentId, keyAgentId, currentModel]);

  /** The catalog as it really is: read the cache, fetch once when it is still cold. */
  const loadProviders = useCallback(async (): Promise<ProviderSnapshotEntry[] | undefined> => {
    const queryKey = providersSnapshotQueryKey(serverId, cwd);
    const cached = queryClient.getQueryData<{ entries?: ProviderSnapshotEntry[] }>(queryKey);
    if (cached?.entries) return cached.entries;
    await queryClient.refetchQueries({ queryKey, type: "active" });
    return queryClient.getQueryData<{ entries?: ProviderSnapshotEntry[] }>(queryKey)?.entries;
  }, [cwd, queryClient, serverId]);

  const loadStatus = useCallback(async (): Promise<CollaborationState | undefined> => {
    const queryKey = collaborationQueryKey(serverId);
    const cached = queryClient.getQueryData<CollaborationState>(queryKey);
    if (cached) return cached;
    await refetch();
    return queryClient.getQueryData<CollaborationState>(queryKey);
  }, [queryClient, refetch, serverId]);

  const startQuick = useCallback(async () => {
    if (isCollaborationEnablePending(serverId, keyAgentId)) return;
    const remembered = rememberedLaunch(serverId);
    // A first task has no setup to reuse; the form is the point.
    if (!remembered) {
      openConfig();
      return;
    }
    const requestId =
      selectCollaborationRequest(useCollaborationEnableStore.getState(), key) ?? randomUUID();
    beginCollaborationEnable(key, requestId);
    try {
      const [entries, status] = await Promise.all([loadProviders(), loadStatus()]);
      if (!entries || !status) {
        // Truly unavailable (no catalog or no host status): fall back to the form.
        settleCollaborationEnable(key);
        openConfig();
        return;
      }
      const existing = agentId
        ? status.conversations.find((entry) => entry.agentId === agentId)
        : undefined;
      if (existing) {
        // Already collaborating: the control's job here is to configure, not to enable again.
        settleCollaborationEnable(key);
        openConfig();
        return;
      }
      const decision = resolveQuickLaunch({
        snapshot: {
          ready: true,
          settings: status.settings ?? null,
          conversation: existing,
          currentAgent: Boolean(agentId),
          currentModel,
        },
        remembered,
        providers: entries,
        capabilities: {
          inlineModels: supportsInlineModels,
          executeReview: supportsExecuteReview,
          worktree: supportsWorktree,
        },
      });
      if (decision.kind === "configure") {
        settleCollaborationEnable(key);
        openConfig();
        return;
      }
      const opened = await enableCollaboration({
        serverId,
        workspaceId,
        agentId,
        keyAgentId,
        requestId,
        ...decision.resolution,
      });
      // The host's own state makes the new conversation visible without waiting for the poll.
      if (opened) queryClient.setQueryData(collaborationQueryKey(serverId), opened);
      settleCollaborationEnable(key);
    } catch (cause) {
      settleCollaborationEnable(key, cause instanceof Error ? cause.message : String(cause));
    }
  }, [
    agentId,
    currentModel,
    key,
    keyAgentId,
    loadProviders,
    loadStatus,
    openConfig,
    queryClient,
    serverId,
    supportsExecuteReview,
    supportsInlineModels,
    supportsWorktree,
    workspaceId,
  ]);

  const statusError = query.error?.message ?? query.data?.error ?? null;
  const press = useCallback(() => {
    if (pending) return;
    // A retry is the only useful action after a failed enable.
    if (error) {
      void startQuick();
      return;
    }
    if (enabled || !supportsInlineModels || statusError) {
      openConfig();
      return;
    }
    // Nothing remembered: the first task goes straight to the form.
    if (!rememberedLaunch(serverId)) {
      openConfig();
      return;
    }
    void startQuick();
  }, [
    enabled,
    error,
    openConfig,
    pending,
    serverId,
    startQuick,
    statusError,
    supportsInlineModels,
  ]);

  const label = resolveCollaborationLabel({
    t,
    enabled,
    pending,
    error,
    mode: conversation ? collaborationMode(conversation) : null,
  });

  return (
    <>
      <AgentControlTrigger
        icon={pending ? PendingGlyph : Users}
        surface="toolbar"
        label={t("collaboration.title")}
        value={label}
        showCaret={false}
        disabled={pending}
        onPress={press}
        accessibilityLabel={error ?? t("collaboration.chooseMode")}
        testID="composer-collaboration"
      />
      <ChevronEntry
        onPress={openConfig}
        disabled={pending}
        accessibilityLabel={t("collaboration.configure")}
      />
    </>
  );
}

function resolveCollaborationLabel(input: {
  t: TFunction;
  enabled: boolean;
  pending: boolean;
  error: string | null;
  mode: CollaborationMode | null;
}): string {
  const title = input.t("collaboration.title");
  if (input.error) return input.t("collaboration.retry");
  if (input.enabled && input.mode)
    return `${title} · ${input.t(`collaboration.modes.${input.mode}`)}`;
  if (input.pending) return input.t("collaboration.enabling");
  return title;
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const chevronTriggerStyle = ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
  styles.chevron,
  hovered && styles.chevronHovered,
  pressed && styles.chevronPressed,
];

function ChevronEntry({
  onPress,
  disabled,
  accessibilityLabel,
}: {
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
}) {
  return (
    <ComboboxTrigger
      chevron={null}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID="composer-collaboration-config"
      style={chevronTriggerStyle}
    >
      <ThemedChevronDown size={14} uniProps={mutedIconColorMapping} />
    </ComboboxTrigger>
  );
}

const styles = StyleSheet.create((theme) => ({
  chevron: {
    height: 28,
    minWidth: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  chevronHovered: {
    backgroundColor: theme.colors.surface2,
  },
  chevronPressed: {
    backgroundColor: theme.colors.surface0,
  },
}));
