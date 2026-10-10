import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Keyboard, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  CollaborationIsolation,
  CollaborationMode,
} from "@getpaseo/protocol/collaboration/schema";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsCard, SettingsCollapsibleRow } from "@/components/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature, useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { LaunchIsolationOptions, LaunchModeOptions } from "./launch-mode-options";
import { LaunchGoal } from "./launch-goal";
import { LaunchSummary } from "./launch-summary";
import { enableCollaboration, type CollaborationTarget } from "./launch";
import {
  MAX_REWORKS_LIMIT,
  RUN_TIMEOUT_HOURS,
  openCollaborationLaunch,
  type LaunchLimits,
  type LaunchSnapshot,
  type LaunchSelections,
  type LaunchRole,
} from "./launch-model";
import { closeCollaborationLaunch, useCollaborationLaunchStore } from "./launch-store";
import { rememberLaunch, rememberedLaunch } from "./launch-preferences";
import {
  beginCollaborationEnable,
  collaborationEnableKey,
  settleCollaborationEnable,
} from "./enable-store";
import { collaborationQueryKey, useCollaboration } from "./use-collaboration";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";

const launchSnapPoints = ["75%", "90%"];
export function CollaborationLaunchHost() {
  const request = useCollaborationLaunchStore((state) => state.request);
  return request ? <LaunchDialog key={request.requestId} target={request} /> : null;
}
function LaunchDialog({ target }: { target: CollaborationTarget }) {
  const [closing, setClosing] = useState(false);
  const pathname = usePathname();
  const [origin] = useState(() => useCollaborationLaunchStore.getState().originPath ?? pathname);
  const configuring = useCollaborationLaunchStore((state) => state.configuring);
  const { query, supportsInlineModels } = useCollaboration(target.serverId);
  const configPath = buildSettingsHostSectionRoute(target.serverId, "collaboration");
  const close = useCallback(() => setClosing(true), []);
  const dismissed = useCallback(() => {
    if (closing && useCollaborationLaunchStore.getState().request?.requestId === target.requestId)
      closeCollaborationLaunch();
  }, [closing, target.requestId]);
  useEffect(() => {
    useCollaborationLaunchStore.setState({ originPath: origin });
    Keyboard.dismiss();
  }, [origin]);
  useEffect(() => {
    if (pathname === origin) useCollaborationLaunchStore.setState({ configuring: false });
    else if (pathname !== configPath) setClosing(true);
  }, [pathname, origin, configPath]);
  const configure = useCallback(
    (selections: LaunchSelections, limits: LaunchLimits) => {
      useCollaborationLaunchStore.setState((state) => ({
        configuring: true,
        request: state.request ? { ...state.request, selections, limits } : null,
      }));
      router.push(configPath);
    },
    [configPath],
  );
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);
  const snapshot = useMemo<LaunchSnapshot>(
    () => ({
      ready: Boolean(query.data),
      settings: query.data?.settings ?? null,
      conversation: query.data?.conversations.find((entry) =>
        target.agentId ? entry.agentId === target.agentId : entry.requestId === target.requestId,
      ),
      currentAgent: Boolean(target.agentId),
      currentModel: target.currentModel,
    }),
    [query.data, target.agentId, target.requestId, target.currentModel],
  );
  const visible = pathname === origin && !configuring && !closing;
  return (
    <ModePicker
      target={target}
      snapshot={snapshot}
      visible={visible}
      onConfigure={configure}
      onClose={close}
      onDismiss={dismissed}
      onRetry={retry}
      error={query.error?.message ?? query.data?.error ?? null}
      supported={supportsInlineModels}
    />
  );
}

interface ModePickerProps {
  target: CollaborationTarget;
  snapshot: LaunchSnapshot;
  visible: boolean;
  onConfigure: (selections: LaunchSelections, limits: LaunchLimits) => void;
  onClose: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  error: string | null;
  supported: boolean;
}
function canStartLaunch(
  ready: boolean | undefined,
  state: { canContinue: boolean; isolation: CollaborationIsolation },
  supportsWorktree: boolean | null,
): boolean {
  if (!ready || !state.canContinue) return false;
  return state.isolation !== "worktree" || supportsWorktree === true;
}
function ModePicker({
  target,
  snapshot,
  visible,
  onConfigure,
  onClose,
  onDismiss,
  onRetry,
  error,
  supported,
}: ModePickerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const supportsExecuteReview = useHostFeature(target.serverId, "collaborationExecuteReview");
  const supportsWorktree =
    useHostFeatureAvailabilityMap([target.serverId], "collaborationWorktree").get(
      target.serverId,
    ) ?? null;
  const [model] = useState(() =>
    openCollaborationLaunch(
      snapshot,
      target.mode,
      target.selections,
      target.limits,
      rememberedLaunch(target.serverId),
    ),
  );
  useEffect(() => () => model.close(), [model]);
  useEffect(() => model.applySnapshot(snapshot), [model, snapshot]);
  const cwd = useWorkspaceFields(
    target.serverId,
    target.workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const catalog = useProvidersSnapshot(target.serverId, { cwd, enabled: visible && supported });
  useEffect(() => {
    if (catalog.entries) model.applyProviders(catalog.entries);
  }, [model, catalog.entries]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  // With a remembered setup, a new task starts from a summary; the full form is one tap away.
  // The composer's config entry opens straight on the form.
  const [editing, setEditing] = useState(
    () => Boolean(target.edit) || !rememberedLaunch(target.serverId),
  );
  const summarized = !editing && !state.agentsLocked;
  const incomplete =
    Boolean(catalog.entries) && snapshot.ready && !state.pending && !state.canContinue;
  useEffect(() => {
    if (incomplete) setEditing(true);
  }, [incomplete]);
  const edit = useCallback(() => setEditing(true), []);
  const header = useMemo(
    () => ({
      title: t("collaboration.chooseMode"),
      subtitle: <Text style={styles.secondary}>{t("collaboration.launch.subtitle")}</Text>,
    }),
    [t],
  );
  const close = useCallback(() => {
    if (useCollaborationLaunchStore.getState().request?.requestId !== target.requestId) return;
    if (!model.getState().pending) onClose();
  }, [model, target.requestId, onClose]);
  const start = useCallback(() => {
    // A second trigger would no-op through model.start and settle the first request early.
    const current = model.getState();
    if (current.pending || !current.canContinue) return;
    // The same key the composer's send and one-tap path use, so a form enable blocks a send too.
    const key = collaborationEnableKey(target.serverId, target.keyAgentId ?? target.agentId ?? "");
    void (async () => {
      await model.start(async (mode, settings, isolation) => {
        // Record the form's request id so a failure can be retried from the composer on the same request.
        beginCollaborationEnable(key, target.requestId);
        const opened = await enableCollaboration({ ...target, mode, settings, isolation });
        // The host's own state makes the new conversation visible without waiting for the poll.
        if (opened) queryClient.setQueryData(collaborationQueryKey(target.serverId), opened);
        // Settings are only sent for a new task, which is what the next dialog should start from.
        if (settings) rememberLaunch(target.serverId, model.preferences());
        onClose();
      });
      // The model keeps its own error; mirror it so the composer surfaces the same failure.
      settleCollaborationEnable(key, model.getState().error || undefined);
    })();
  }, [model, target, onClose, queryClient]);
  const retryCatalog = useCallback(() => {
    catalog.refetchIfStale();
  }, [catalog]);
  const ready = snapshot.ready && supported && !error;
  let unavailable = <Spinner />;
  if (snapshot.ready && !supported)
    unavailable = (
      <Text style={styles.secondary}>{t("collaboration.launchErrors.updateHost")}</Text>
    );
  if (error)
    unavailable = (
      <View style={styles.content}>
        <Text style={styles.error}>{error}</Text>
        <Button onPress={onRetry}>{t("collaboration.retry")}</Button>
      </View>
    );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
      onDismiss={onDismiss}
      dismissible={!state.pending}
      desktopMaxWidth={560}
      snapPoints={launchSnapPoints}
      testID="collaboration-mode-dialog"
      footer={
        <>
          <Button
            onPress={close}
            disabled={state.pending}
            variant="ghost"
            testID="collaboration-launch-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            onPress={start}
            disabled={!canStartLaunch(ready, state, supportsWorktree)}
            loading={state.pending}
            testID="collaboration-continue"
          >
            {t("collaboration.continue")}
          </Button>
        </>
      }
    >
      {ready ? (
        <View style={styles.content}>
          {summarized ? (
            <>
              {target.goal && <LaunchGoal goal={target.goal} />}
              <LaunchSummary state={state} loading={!catalog.entries} onEdit={edit} />
            </>
          ) : (
            <LaunchForm
              target={target}
              model={model}
              state={state}
              supportsExecuteReview={supportsExecuteReview}
              supportsWorktree={supportsWorktree}
              catalogLoaded={Boolean(catalog.entries)}
              onConfigure={onConfigure}
            />
          )}
          {catalog.error && (
            <View style={styles.roles}>
              <Text style={styles.error}>{catalog.error}</Text>
              <Button onPress={retryCatalog}>{t("collaboration.retry")}</Button>
            </View>
          )}
          {state.locked && <Text style={styles.secondary}>{t("collaboration.modeLocked")}</Text>}
          {state.error && (
            <Text style={styles.error} accessibilityRole="alert">
              {state.error}
            </Text>
          )}
        </View>
      ) : (
        unavailable
      )}
    </AdaptiveModalSheet>
  );
}
type LaunchModel = ReturnType<typeof openCollaborationLaunch>;
function LaunchForm({
  target,
  model,
  state,
  supportsExecuteReview,
  supportsWorktree,
  catalogLoaded,
  onConfigure,
}: {
  target: CollaborationTarget;
  model: LaunchModel;
  state: ReturnType<LaunchModel["getState"]>;
  supportsExecuteReview: boolean;
  supportsWorktree: boolean | null;
  catalogLoaded: boolean;
  onConfigure: (selections: LaunchSelections, limits: LaunchLimits) => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const select = useCallback(
    (mode: CollaborationMode) => {
      model.selectMode(mode);
      useCollaborationLaunchStore.setState((current) => ({
        request: current.request ? { ...current.request, mode: model.getState().mode } : null,
      }));
    },
    [model],
  );
  const selectIsolation = useCallback(
    (isolation: CollaborationIsolation) => {
      model.selectIsolation(isolation);
    },
    [model],
  );
  const configure = useCallback(() => {
    const current = model.getState();
    onConfigure(current.selections, {
      maxReworks: current.maxReworks,
      runTimeoutMs: current.runTimeoutMs,
    });
  }, [model, onConfigure]);
  const advancedSummaryNode = useMemo(
    () => (
      <Text style={styles.summary}>
        {`${t("collaboration.maxReworks")} ${state.maxReworks} · ${t(
          "collaboration.launch.runHours",
          {
            count: Math.round(state.runTimeoutMs / 3600000),
          },
        )}`}
      </Text>
    ),
    [state.maxReworks, state.runTimeoutMs, t],
  );
  const promptButton = useMemo(
    () => (
      <Button
        onPress={configure}
        size={size}
        variant="ghost"
        style={styles.advancedAction}
        disabled={state.pending}
        testID="collaboration-manage-prompts"
      >
        {t("collaboration.launch.prompts")}
      </Button>
    ),
    [configure, size, state.pending, t],
  );
  return (
    <>
      <LaunchModeOptions
        mode={state.mode}
        disabled={state.locked || state.pending}
        supportsExecuteReview={supportsExecuteReview}
        onSelect={select}
      />
      <SettingsSection title={t("newWorkspace.isolation.label")} flush>
        <LaunchIsolationOptions
          isolation={state.isolation}
          disabled={state.locked || state.pending}
          supportsWorktree={supportsWorktree}
          onSelect={selectIsolation}
        />
      </SettingsSection>
      {target.goal && <LaunchGoal goal={target.goal} />}
      <SettingsSection title={t("collaboration.launch.agents")} flush>
        {!catalogLoaded && !state.agentsLocked ? (
          <Spinner />
        ) : (
          <View style={styles.roles}>
            {state.showDirector && <RoleModels role="director" model={model} state={state} />}
            <RoleModels role="worker" model={model} state={state} />
            <RoleModels role="reviewer" model={model} state={state} />
          </View>
        )}
      </SettingsSection>
      <SettingsCard>
        <SettingsCollapsibleRow
          label={t("collaboration.launch.advanced")}
          value={advancedSummaryNode}
          testID="collaboration-advanced"
        >
          <View style={styles.advanced}>
            <TaskLimits model={model} state={state} />
            {promptButton}
          </View>
        </SettingsCollapsibleRow>
      </SettingsCard>
    </>
  );
}
interface RoleModelsProps {
  role: LaunchRole;
  model: LaunchModel;
  state: ReturnType<LaunchModel["getState"]>;
}
function RoleModels({ role, model, state }: RoleModelsProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const selection = state.selections[role];
  const optionalReview = role === "reviewer" && state.mode === "full";
  const options = useMemo(
    () =>
      optionalReview
        ? [
            {
              id: "",
              value: "",
              label: t("collaboration.sameReviewer"),
              testID: "collaboration-reviewer-use-lead",
            },
            ...state.providerOptions,
          ]
        : state.providerOptions,
    [optionalReview, state.providerOptions, t],
  );
  // Prefer the catalog's label: an inherited model carries a raw id, not a display name.
  const providerDisplay = useMemo(() => {
    if (!selection) return null;
    const option = state.providerOptions.find((entry) => entry.value === selection.provider);
    return { label: option?.label ?? selection.providerLabel };
  }, [selection, state.providerOptions]);
  const modelDisplay = useMemo(() => {
    if (!selection?.model) return null;
    const option = state.modelOptions[role].find((entry) => entry.value === selection.model);
    return { label: option?.label ?? selection.modelLabel };
  }, [role, selection, state.modelOptions]);
  const changeProvider = useCallback(
    (value: string, display: { label: string }) => model.selectProvider(role, value, display.label),
    [model, role],
  );
  const changeModel = useCallback(
    (value: string, display: { label: string }) => model.selectModel(role, value, display.label),
    [model, role],
  );
  const thinkingOptions = useMemo(
    () => [
      {
        id: "",
        value: "",
        label: t("delegation.providerDefaults"),
        testID: "collaboration-thinking-option-default",
      },
      ...state.thinkingOptions[role],
    ],
    [state.thinkingOptions, role, t],
  );
  const thinkingDisplay = useMemo(
    () => ({
      label: selection?.thinkingOptionId
        ? (selection.thinkingOptionLabel ??
          formatThinkingOptionLabel({ id: selection.thinkingOptionId }))
        : t("delegation.providerDefaults"),
    }),
    [selection, t],
  );
  const changeThinking = useCallback(
    (value: string, display: { label: string }) => model.selectThinking(role, value, display.label),
    [model, role],
  );
  const disabled = state.pending || state.agentsLocked;
  return (
    <View style={styles.role} testID={`collaboration-launch-${role}`}>
      <Text style={styles.roleLabel}>{t(`collaboration.${role}ProfileId`)}</Text>
      <View style={[styles.fields, compact && styles.compactFields]}>
        <View style={styles.field}>
          <SelectField
            field={false}
            size={size}
            label={t("collaboration.launch.provider")}
            triggerTestID={`collaboration-${role}-provider`}
            value={selection?.provider ?? null}
            selectedDisplay={providerDisplay}
            options={options}
            onChange={changeProvider}
            disabled={disabled}
            searchable
            placeholder={
              optionalReview ? t("collaboration.sameReviewer") : t("collaboration.launch.provider")
            }
            emptyText={t("collaboration.launch.noProviders")}
          />
        </View>
        {selection && (
          <View style={styles.field}>
            <SelectField
              field={false}
              size={size}
              label={t("collaboration.launch.model")}
              triggerTestID={`collaboration-${role}-model`}
              value={selection.model || null}
              selectedDisplay={modelDisplay}
              options={state.modelOptions[role]}
              onChange={changeModel}
              disabled={disabled}
              searchable
              placeholder={t("collaboration.launch.model")}
              emptyText={t("collaboration.launch.noModels")}
            />
          </View>
        )}
        {selection && (state.thinkingOptions[role].length > 0 || selection.thinkingOptionId) && (
          <View style={styles.field}>
            <SelectField
              field={false}
              size={size}
              label={t("agentControls.thinking.title")}
              triggerTestID={`collaboration-${role}-thinking`}
              value={selection.thinkingOptionId ?? ""}
              selectedDisplay={thinkingDisplay}
              options={thinkingOptions}
              onChange={changeThinking}
              disabled={disabled}
              placeholder={t("agentControls.thinking.select")}
              emptyText={t("common.empty.noResults")}
            />
          </View>
        )}
      </View>
    </View>
  );
}
const reworkOptions = Array.from({ length: MAX_REWORKS_LIMIT + 1 }, (_, count) => ({
  id: String(count),
  value: String(count),
  label: String(count),
  testID: `collaboration-max-reworks-option-${count}`,
}));
function TaskLimits({ model, state }: Omit<RoleModelsProps, "role">) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const disabled = state.pending || state.agentsLocked;
  const reworkDisplay = useMemo(() => ({ label: String(state.maxReworks) }), [state.maxReworks]);
  const hoursLabel = useCallback(
    (ms: number) => t("collaboration.launch.runHours", { count: Math.round(ms / 3600000) }),
    [t],
  );
  const timeoutOptions = useMemo(
    () =>
      RUN_TIMEOUT_HOURS.map((hours) => ({
        id: String(hours),
        value: String(hours * 3600000),
        label: t("collaboration.launch.runHours", { count: hours }),
        testID: `collaboration-run-timeout-option-${hours}`,
      })),
    [t],
  );
  const timeoutDisplay = useMemo(
    () => ({ label: hoursLabel(state.runTimeoutMs) }),
    [hoursLabel, state.runTimeoutMs],
  );
  const changeReworks = useCallback(
    (value: string) => model.selectMaxReworks(Number(value)),
    [model],
  );
  const changeTimeout = useCallback(
    (value: string) => model.selectRunTimeout(Number(value)),
    [model],
  );
  return (
    <View style={styles.role}>
      <View style={[styles.fields, compact && styles.compactFields]}>
        <View style={styles.limitField}>
          <Text style={styles.roleLabel}>{t("collaboration.maxReworks")}</Text>
          <SelectField
            field={false}
            size={size}
            label={t("collaboration.maxReworks")}
            triggerTestID="collaboration-max-reworks"
            value={String(state.maxReworks)}
            selectedDisplay={reworkDisplay}
            options={reworkOptions}
            onChange={changeReworks}
            disabled={disabled}
            placeholder={t("collaboration.maxReworks")}
            emptyText={t("collaboration.maxReworks")}
          />
        </View>
        <View style={styles.limitField}>
          <Text style={styles.roleLabel}>{t("collaboration.launch.runTimeout")}</Text>
          <SelectField
            field={false}
            size={size}
            label={t("collaboration.launch.runTimeout")}
            triggerTestID="collaboration-run-timeout"
            value={String(state.runTimeoutMs)}
            selectedDisplay={timeoutDisplay}
            options={timeoutOptions}
            onChange={changeTimeout}
            disabled={disabled}
            placeholder={t("collaboration.launch.runTimeout")}
            emptyText={t("collaboration.launch.runTimeout")}
          />
        </View>
      </View>
      <Text style={styles.secondary}>{t("collaboration.launch.maxReworksHint")}</Text>
      <Text style={styles.secondary}>{t("collaboration.launch.runTimeoutHint")}</Text>
    </View>
  );
}
const Spinner = withUnistyles(LoadingSpinner, (theme) => ({ color: theme.colors.foregroundMuted }));
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[6] },
  roles: { gap: theme.spacing[4] },
  role: { gap: theme.spacing[2] },
  roleLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  fields: { flexDirection: "row", gap: theme.spacing[2] },
  compactFields: { flexDirection: "column" },
  field: { flex: 1, minWidth: 0 },
  limitField: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  summary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  advanced: {
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  advancedAction: { alignSelf: "flex-start" },
}));
