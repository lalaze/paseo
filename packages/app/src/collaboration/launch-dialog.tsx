import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { LaunchIsolationOptions, LaunchModeOptions } from "./launch-mode-options";
import { LaunchGoal } from "./launch-goal";
import { enableCollaboration, type CollaborationTarget } from "./launch";
import {
  openCollaborationLaunch,
  type LaunchSnapshot,
  type LaunchSelections,
  type LaunchRole,
} from "./launch-model";
import { closeCollaborationLaunch, useCollaborationLaunchStore } from "./launch-store";
import { useCollaboration } from "./use-collaboration";

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
    (selections: LaunchSelections) => {
      useCollaborationLaunchStore.setState((state) => ({
        configuring: true,
        request: state.request ? { ...state.request, selections } : null,
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
    }),
    [query.data, target.agentId, target.requestId],
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
  onConfigure: (selections: LaunchSelections) => void;
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
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const supportsWorktree =
    useHostFeatureAvailabilityMap([target.serverId], "collaborationWorktree").get(
      target.serverId,
    ) ?? null;
  const [model] = useState(() => openCollaborationLaunch(snapshot, target.mode, target.selections));
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
  const header = useMemo(
    () => ({
      title: t("collaboration.chooseMode"),
      subtitle: <Text style={styles.secondary}>{t("collaboration.launch.subtitle")}</Text>,
    }),
    [t],
  );
  const select = useCallback(
    (mode: CollaborationMode) => {
      model.selectMode(mode);
      useCollaborationLaunchStore.setState((current) => ({
        request: current.request ? { ...current.request, mode: model.getState().mode } : null,
      }));
    },
    [model],
  );
  const close = useCallback(() => {
    if (useCollaborationLaunchStore.getState().request?.requestId !== target.requestId) return;
    if (!model.getState().pending) onClose();
  }, [model, target.requestId, onClose]);
  const start = useCallback(() => {
    void model.start(async (mode, settings, isolation) => {
      await enableCollaboration({ ...target, mode, settings, isolation });
      onClose();
    });
  }, [model, target, onClose]);
  const selectIsolation = useCallback(
    (isolation: CollaborationIsolation) => {
      model.selectIsolation(isolation);
    },
    [model],
  );
  const configure = useCallback(
    () => onConfigure(model.getState().selections),
    [model, onConfigure],
  );
  const promptButton = useMemo(
    () => (
      <Button
        onPress={configure}
        size={size}
        variant="ghost"
        disabled={state.pending}
        testID="collaboration-manage-prompts"
      >
        {t("collaboration.launch.prompts")}
      </Button>
    ),
    [configure, size, state.pending, t],
  );
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
          <LaunchModeOptions
            mode={state.mode}
            disabled={state.locked || state.pending}
            supportsExecuteReview
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
          <SettingsSection title={t("collaboration.launch.agents")} flush trailing={promptButton}>
            {!catalog.entries && !state.agentsLocked ? (
              <Spinner />
            ) : (
              <View style={styles.roles}>
                {state.showDirector && <RoleModels role="director" model={model} state={state} />}
                <RoleModels role="worker" model={model} state={state} />
                <RoleModels role="reviewer" model={model} state={state} />
              </View>
            )}
          </SettingsSection>
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
  const providerDisplay = useMemo(
    () => (selection ? { label: selection.providerLabel } : null),
    [selection],
  );
  const modelDisplay = useMemo(
    () => (selection?.model ? { label: selection.modelLabel } : null),
    [selection],
  );
  const changeProvider = useCallback(
    (value: string, display: { label: string }) => model.selectProvider(role, value, display.label),
    [model, role],
  );
  const changeModel = useCallback(
    (value: string, display: { label: string }) => model.selectModel(role, value, display.label),
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
      </View>
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
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
