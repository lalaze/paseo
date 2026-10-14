import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { randomUUID } from "expo-crypto";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { findActiveConversation, useCollaboration } from "./use-collaboration";
import type { CollaborationNoticeExecution } from "./message-summary";
import {
  manualSwitchTarget,
  openExecutionSwitch,
  type ExecutionSwitchState,
  type ExecutionSwitchTarget,
} from "./execution-switch";

const snapPoints = ["75%", "90%"];

function statusCopy(
  state: ExecutionSwitchState,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (state.support === false) return t("collaboration.handoff.updateHost");
  if (state.status === "pending") return t("collaboration.handoff.pending");
  if (state.status === "success")
    return t("collaboration.handoff.success", { model: state.succeededLabel });
  if (state.status === "error") return state.error;
  return t("collaboration.handoff.progressKept");
}

/** Manual model choice for the current quota block. Closed sheets mount nothing. */
export function ExecutionSwitchSheet({
  visible,
  onClose,
  serverId,
  workspaceId,
  target,
}: {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  workspaceId: string;
  target: ExecutionSwitchTarget;
}) {
  if (!visible) return null;
  return (
    <ExecutionSwitchForm
      key={`${target.runId}:${target.expectedOperationId}:${target.token}`}
      onClose={onClose}
      serverId={serverId}
      workspaceId={workspaceId}
      target={target}
    />
  );
}

function fieldsLocked(state: ExecutionSwitchState) {
  return state.pending || state.status === "success" || state.support === false;
}

function SwitchContext({
  target,
  alert,
  copy,
}: {
  target: ExecutionSwitchTarget;
  alert: boolean;
  copy: string;
}) {
  const { t } = useTranslation();
  const attempted = target.attempted.map((item) => item.provider).join(", ");
  const current = target.current?.provider;
  return (
    <>
      {current ? (
        <Text style={styles.primary} testID="collaboration-switch-current">
          {`${t("collaboration.handoff.current")}: ${current}`}
        </Text>
      ) : null}
      {attempted ? (
        <Text
          style={styles.secondary}
        >{`${t("collaboration.handoff.attempted")}: ${attempted}`}</Text>
      ) : null}
      <Text
        style={alert ? styles.error : styles.secondary}
        accessibilityRole={alert ? "alert" : undefined}
        testID="collaboration-switch-status"
      >
        {copy}
      </Text>
    </>
  );
}

function SwitchModelFields({
  state,
  size,
  providerDisplay,
  modelDisplay,
  thinkingDisplay,
  thinkingOptions,
  onProvider,
  onModel,
  onThinking,
}: {
  state: ExecutionSwitchState;
  size: "sm" | "md";
  providerDisplay: { label: string } | null;
  modelDisplay: { label: string } | null;
  thinkingDisplay: { label: string };
  thinkingOptions: ExecutionSwitchState["thinkingOptions"];
  onProvider: (value: string, display: { label: string }) => void;
  onModel: (value: string, display: { label: string }) => void;
  onThinking: (value: string, display: { label: string }) => void;
}) {
  const { t } = useTranslation();
  const locked = fieldsLocked(state);
  const showThinking = state.thinkingOptions.length > 0 || Boolean(state.thinkingOptionId);
  return (
    <>
      <SelectField
        field={false}
        size={size}
        label={t("collaboration.launch.provider")}
        triggerTestID="collaboration-switch-provider"
        value={state.provider || null}
        selectedDisplay={providerDisplay}
        options={state.providerOptions}
        onChange={onProvider}
        disabled={locked}
        searchable
        placeholder={t("collaboration.launch.provider")}
        emptyText={t("collaboration.launch.noProviders")}
      />
      {state.provider ? (
        <SelectField
          field={false}
          size={size}
          label={t("collaboration.launch.model")}
          triggerTestID="collaboration-switch-target"
          value={state.model || null}
          selectedDisplay={modelDisplay}
          options={state.modelOptions}
          onChange={onModel}
          disabled={locked}
          searchable
          placeholder={t("collaboration.launch.model")}
          emptyText={t("collaboration.launch.noModels")}
        />
      ) : null}
      {state.provider && showThinking ? (
        <SelectField
          field={false}
          size={size}
          label={t("agentControls.thinking.title")}
          triggerTestID="collaboration-switch-thinking"
          value={state.thinkingOptionId}
          selectedDisplay={thinkingDisplay}
          options={thinkingOptions}
          onChange={onThinking}
          disabled={locked}
          placeholder={t("agentControls.thinking.select")}
          emptyText={t("common.empty.noResults")}
        />
      ) : null}
    </>
  );
}

function ExecutionSwitchForm({
  onClose,
  serverId,
  workspaceId,
  target,
}: {
  onClose: () => void;
  serverId: string;
  workspaceId: string;
  target: ExecutionSwitchTarget;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const { client, query } = useCollaboration(serverId);
  const support =
    useHostFeatureAvailabilityMap([serverId], "collaborationExecutionHandoff").get(serverId) ??
    null;
  const [model] = useState(() =>
    openExecutionSwitch({
      requestId: randomUUID(),
      createRequestId: () => randomUUID(),
      runId: target.runId,
      expectedOperationId: target.expectedOperationId,
      token: target.token,
    }),
  );
  useEffect(() => () => model.close(), [model]);
  useEffect(() => model.applySupport(support), [model, support]);
  const cwd = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.workspaceDirectory,
  );
  const catalog = useProvidersSnapshot(serverId, { cwd, enabled: true });
  useEffect(() => {
    if (catalog.entries) model.applyProviders(catalog.entries);
  }, [catalog.entries, model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const close = useCallback(() => {
    if (!state.pending) onClose();
  }, [onClose, state.pending]);
  const submit = useCallback(() => {
    void model.submit(async (input) => {
      if (!client) throw new Error("Host disconnected");
      const next = await client.collaborationCommand("run.switch_executor", input);
      if (next.error) throw new Error(next.error);
      await query.refetch();
    });
  }, [client, model, query]);
  const providerDisplay = useMemo(
    () => (state.provider ? { label: state.providerLabel || state.provider } : null),
    [state.provider, state.providerLabel],
  );
  const modelDisplay = useMemo(
    () => (state.model ? { label: state.modelLabel || state.model } : null),
    [state.model, state.modelLabel],
  );
  const thinkingOptions = useMemo(
    () => [
      {
        id: "",
        value: "",
        label: t("delegation.providerDefaults"),
        testID: "collaboration-switch-thinking-default",
      },
      ...state.thinkingOptions,
    ],
    [state.thinkingOptions, t],
  );
  const thinkingDisplay = useMemo(
    () => ({
      label: state.thinkingOptionId
        ? state.thinkingOptionLabel || formatThinkingOptionLabel({ id: state.thinkingOptionId })
        : t("delegation.providerDefaults"),
    }),
    [state.thinkingOptionId, state.thinkingOptionLabel, t],
  );
  const changeProvider = useCallback(
    (value: string, display: { label: string }) => model.selectProvider(value, display.label),
    [model],
  );
  const changeModel = useCallback(
    (value: string, display: { label: string }) => model.selectModel(value, display.label),
    [model],
  );
  const changeThinking = useCallback(
    (value: string, display: { label: string }) => model.selectThinking(value, display.label),
    [model],
  );
  const header = useMemo(() => ({ title: t("collaboration.handoff.title") }), [t]);
  const copy = statusCopy(state, t);
  const alert = state.support === false || state.status === "error";
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={close}
      dismissible={!state.pending}
      desktopMaxWidth={560}
      snapPoints={snapPoints}
      testID="collaboration-switch-sheet"
      footer={
        <>
          <Button
            onPress={close}
            disabled={state.pending}
            variant="ghost"
            testID="collaboration-switch-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            onPress={submit}
            disabled={!state.canSubmit}
            loading={state.pending}
            testID="collaboration-switch-submit"
          >
            {t("collaboration.handoff.submit")}
          </Button>
        </>
      }
    >
      <View style={styles.content}>
        <SwitchContext target={target} alert={alert} copy={copy} />
        <SwitchModelFields
          state={state}
          size={size}
          providerDisplay={providerDisplay}
          modelDisplay={modelDisplay}
          thinkingDisplay={thinkingDisplay}
          thinkingOptions={thinkingOptions}
          onProvider={changeProvider}
          onModel={changeModel}
          onThinking={changeThinking}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

interface HandoffSession {
  workspaceId: string;
  target: ExecutionSwitchTarget;
}

function openedHandoff(
  execution: CollaborationNoticeExecution | undefined,
  conversation: ReturnType<typeof findActiveConversation>,
) {
  const notice = execution?.relay;
  const run = conversation?.run;
  const live = run?.execution?.relay;
  if (!notice || !live || !run) return null;
  if (live.operationId !== notice.operationId || live.token !== notice.token) return null;
  return { live, target: manualSwitchTarget(run, notice) };
}

function currentProvider(conversation: ReturnType<typeof findActiveConversation>) {
  return conversation?.run?.execution?.model?.provider;
}

function HandoffStatusLine({
  current,
  live,
}: {
  current?: string;
  live: { status: "blocked" | "stopping" | "preparing" | "failed"; target?: { provider: string } };
}) {
  const { t } = useTranslation();
  const models = [current, live.target?.provider].filter((item): item is string => Boolean(item));
  const status = t(`collaboration.handoff.status.${live.status}`);
  const label = models.length > 0 ? `${models.join(" → ")} · ${status}` : status;
  return (
    <Text style={styles.secondary} testID="collaboration-handoff-status">
      {label}
    </Text>
  );
}

function HandoffActionView({
  serverId,
  session,
  opened,
  current,
  onShow,
  onHide,
}: {
  serverId: string;
  session: HandoffSession | null;
  opened: ReturnType<typeof openedHandoff>;
  current?: string;
  onShow: () => void;
  onHide: () => void;
}) {
  const { t } = useTranslation();
  const target = opened?.target;
  return (
    <View style={styles.action}>
      {opened ? <HandoffStatusLine current={current} live={opened.live} /> : null}
      {target ? (
        <Button onPress={onShow} variant="outline" size="sm" testID="collaboration-switch-model">
          {t("collaboration.handoff.continue")}
        </Button>
      ) : null}
      {session ? (
        <ExecutionSwitchSheet
          visible
          onClose={onHide}
          serverId={serverId}
          workspaceId={session.workspaceId}
          target={session.target}
        />
      ) : null}
    </View>
  );
}

/** Current quota notice only. An older notice's token does not match, so it renders nothing. */
export function CollaborationHandoffAction({
  serverId,
  agentId,
  execution,
}: {
  serverId: string;
  agentId: string;
  execution?: CollaborationNoticeExecution;
}) {
  const { query } = useCollaboration(serverId);
  const [session, setSession] = useState<HandoffSession | null>(null);
  const conversation = findActiveConversation(query.data, agentId);
  const opened = openedHandoff(execution, conversation);
  const show = useCallback(() => {
    const target = opened?.target;
    if (!target || !conversation) return;
    setSession({ workspaceId: conversation.workspaceId, target });
  }, [conversation, opened]);
  const hide = useCallback(() => setSession(null), []);
  if (!opened && !session) return null;
  return (
    <HandoffActionView
      serverId={serverId}
      session={session}
      opened={opened}
      current={currentProvider(conversation)}
      onShow={show}
      onHide={hide}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  action: { gap: theme.spacing[2], marginTop: theme.spacing[2] },
  content: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  primary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
