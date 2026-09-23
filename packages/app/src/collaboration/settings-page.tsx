import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import type { Settings } from "@getpaseo/protocol/collaboration/schema";
import { useAgentProfiles } from "@/agent-profiles/internal/use-agent-profiles";
import { AgentProfilesSection } from "@/agent-profiles/settings/agent-profiles-section";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openCollaborationSettings } from "./settings-model";

import { buildCollaborationHistoryRoute } from "@/utils/host-routes";
import { useCollaboration } from "./use-collaboration";
import { useCollaborationLaunchStore } from "./launch-store";

type SettingsModel = ReturnType<typeof openCollaborationSettings>;
type EditorState = ReturnType<SettingsModel["getState"]>;
type Size = "sm" | "md";

export function CollaborationPage({ serverId }: { serverId: string }) {
  return <CollaborationHostPage key={serverId} serverId={serverId} />;
}
function CollaborationHostPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { client, query, command } = useCollaboration(serverId);
  const { mutateAsync } = command;
  const compact = useIsCompactFormFactor();
  const openHistory = useCallback(() => {
    router.push(buildCollaborationHistoryRoute(serverId));
  }, [serverId]);
  const { profiles } = useAgentProfiles(serverId);
  const returningToChat = useCollaborationLaunchStore(
    (state) => state.configuring && state.request?.serverId === serverId,
  );
  const returnToChat = useCallback(async () => {
    router.back();
  }, []);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);
  const save = useCallback(
    async (settings: Settings, base: Settings | null) => {
      await mutateAsync({ name: "settings.save", input: { settings, base } });
    },
    [mutateAsync],
  );
  if (!client || query.isPending || !profiles) return <CollaborationSpinner />;
  const error = query.error?.message ?? query.data?.error;
  if (error)
    return (
      <View style={styles.section}>
        <Text style={styles.error}>{error}</Text>
        <Button onPress={retry}>{t("collaboration.retry")}</Button>
      </View>
    );
  const state = query.data;
  if (!state) return null;
  return (
    <View style={styles.section}>
      {returningToChat && (
        <Button onPress={returnToChat} variant="ghost">
          {t("collaboration.continue")}
        </Button>
      )}
      <Button
        variant="outline"
        size={compact ? "md" : "sm"}
        onPress={openHistory}
        testID="collaboration-open-history"
      >
        {t("collaboration.history.title")}
      </Button>
      {state.settings || profiles.some((profile) => profile.model) ? (
        <SettingsEditor
          initial={state.settings}
          profiles={profiles}
          save={save}
          afterSave={returningToChat ? returnToChat : undefined}
        />
      ) : (
        <Text style={styles.text}>{t("collaboration.chooseProfiles")}</Text>
      )}
      <AgentProfilesSection serverId={serverId} />
    </View>
  );
}
function SettingsEditor({
  initial,
  profiles,
  save,
  afterSave,
}: {
  initial: Settings | null;
  profiles: AgentProfile[];
  save: (settings: Settings, base: Settings | null) => Promise<void>;
  afterSave?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() => openCollaborationSettings(initial, profiles));
  useEffect(() => () => model.close(), [model]);
  useEffect(() => model.applyProfiles(profiles), [model, profiles]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const submit = useCallback(() => {
    void model.save(save, afterSave);
  }, [model, save, afterSave]);
  const approval = useCallback(
    (value: boolean) => model.set("requirePlanApproval", value),
    [model],
  );
  return (
    <SettingsSection title={t("collaboration.title")}>
      <View style={styles.section}>
        {(["directorProfileId", "workerProfileId", "reviewerProfileId"] as const).map((role) => (
          <RoleField key={role} role={role} model={model} state={state} size={size} />
        ))}
        <View style={styles.actions}>
          <Text style={styles.text}>{t("collaboration.requireApproval")}</Text>
          <Switch
            value={state.settings.requirePlanApproval}
            disabled={state.saving}
            onValueChange={approval}
          />
        </View>
        {(["plan", "execute", "review"] as const).map((role) => (
          <PromptField key={role} role={role} model={model} state={state} size={size} />
        ))}
        {(["maxAttempts", "maxReworks", "turnTimeoutMs", "runTimeoutMs"] as const).map((field) => (
          <NumberField key={field} field={field} model={model} state={state} size={size} />
        ))}
        <ChecksField model={model} state={state} size={size} />
        <RoutingGroup kind="categoryOverrides" model={model} state={state} size={size} />
        <RoutingGroup kind="taskOverrides" model={model} state={state} size={size} />
        <SelectionField model={model} state={state} size={size} />
        {state.error && <Text style={styles.error}>{state.error}</Text>}
        {state.saved && <Text style={styles.text}>{t("collaboration.saved")}</Text>}
        <Button loading={state.saving} onPress={submit}>
          {t("collaboration.save")}
        </Button>
      </View>
    </SettingsSection>
  );
}
interface EditorFieldProps {
  model: SettingsModel;
  state: EditorState;
  size: Size;
}
function RoleField({
  role,
  model,
  state,
  size,
}: EditorFieldProps & { role: "directorProfileId" | "workerProfileId" | "reviewerProfileId" }) {
  const { t } = useTranslation();
  const options = useMemo(() => {
    const entries = state.choices.map((profile) => ({
      id: profile.id,
      value: profile.id,
      label: profile.label,
      description: profile.provider,
    }));
    return role === "reviewerProfileId"
      ? [{ id: "", value: "", label: t("collaboration.sameReviewer"), description: "" }, ...entries]
      : entries;
  }, [state.choices, role, t]);
  const selected = useMemo(
    () => state.displays[role] ?? { label: t("collaboration.sameReviewer") },
    [state.displays, role, t],
  );
  const change = useCallback((value: string) => model.selectRole(role, value), [model, role]);
  return (
    <SelectField
      size={size}
      triggerTestID={`collaboration-role-${role}`}
      label={t(`collaboration.${role}`)}
      value={state.settings[role] ?? ""}
      selectedDisplay={selected}
      options={options}
      placeholder={t("collaboration.selectProfile")}
      emptyText={t("collaboration.chooseProfiles")}
      disabled={state.saving}
      onChange={change}
    />
  );
}
function PromptField({
  role,
  model,
  state,
  size,
}: EditorFieldProps & { role: "plan" | "execute" | "review" }) {
  const { t } = useTranslation();
  const change = useCallback(
    (value: string) =>
      model.set("rolePrompts", { ...model.getState().settings.rolePrompts, [role]: value }),
    [model, role],
  );
  return (
    <Field label={t(`collaboration.${role}`)}>
      <FormTextInput
        size={size}
        multiline
        accessibilityLabel={t(`collaboration.${role}`)}
        initialValue={state.settings.rolePrompts?.[role] ?? ""}
        editable={!state.saving}
        onChangeText={change}
      />
    </Field>
  );
}
function NumberField({
  field,
  model,
  state,
  size,
}: EditorFieldProps & { field: "maxAttempts" | "maxReworks" | "turnTimeoutMs" | "runTimeoutMs" }) {
  const { t } = useTranslation();
  const multiplier = field.endsWith("TimeoutMs") ? 60000 : 1;
  const change = useCallback(
    (value: string) => model.set(field, Number(value) * multiplier),
    [model, field, multiplier],
  );
  return (
    <Field label={t(`collaboration.${field}`)}>
      <FormTextInput
        size={size}
        accessibilityLabel={t(`collaboration.${field}`)}
        initialValue={String(state.settings[field] / multiplier)}
        keyboardType="number-pad"
        editable={!state.saving}
        onChangeText={change}
      />
    </Field>
  );
}
function ChecksField({ model, state, size }: EditorFieldProps) {
  const { t } = useTranslation();
  const change = useCallback((value: string) => model.setChecks(value), [model]);
  return (
    <Field label={t("collaboration.checks")}>
      <FormTextInput
        size={size}
        multiline
        accessibilityLabel={t("collaboration.checks")}
        initialValue={state.checksText}
        editable={!state.saving}
        onChangeText={change}
      />
    </Field>
  );
}
function SelectionField({ model, state }: EditorFieldProps) {
  const { t } = useTranslation();
  const change = useCallback(
    (value: boolean) => model.set("allowDirectorSelection", value),
    [model],
  );
  return (
    <View style={styles.actions}>
      <Text style={styles.text}>{t("collaboration.allowSelection")}</Text>
      <Switch
        value={state.settings.allowDirectorSelection}
        disabled={state.saving}
        onValueChange={change}
      />
    </View>
  );
}
type RuleKind = "categoryOverrides" | "taskOverrides";
function RoutingGroup({ kind, model, state, size }: EditorFieldProps & { kind: RuleKind }) {
  const { t } = useTranslation();
  const change = useCallback((value: string) => model.setRuleKey(kind, value), [model, kind]);
  const add = useCallback(() => model.addRule(kind), [model, kind]);
  return (
    <SettingsSection title={t(`collaboration.${kind}`)}>
      {Object.entries(state.settings[kind]).map(([name, profileId]) => (
        <RoutingRule
          key={name}
          name={name}
          profileId={profileId}
          kind={kind}
          model={model}
          state={state}
          size={size}
        />
      ))}
      <FormTextInput
        size={size}
        initialValue={state.ruleKeys[kind]}
        placeholder={t(`collaboration.${kind}`)}
        accessibilityLabel={t(`collaboration.${kind}`)}
        onChangeText={change}
        editable={!state.saving}
      />
      <Button onPress={add} disabled={state.saving || !state.ruleKeys[kind].trim()}>
        {t("collaboration.addRule")}
      </Button>
    </SettingsSection>
  );
}
function RoutingRule({
  kind,
  name,
  profileId,
  model,
  state,
  size,
}: EditorFieldProps & { kind: RuleKind; name: string; profileId: string }) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      state.choices.map((profile) => ({ id: profile.id, value: profile.id, label: profile.label })),
    [state.choices],
  );
  const display = useMemo(
    () => ({
      label: state.choices.find((profile) => profile.id === profileId)?.label ?? profileId,
    }),
    [state.choices, profileId],
  );
  const change = useCallback(
    (value: string) => model.setRule(kind, name, value),
    [model, kind, name],
  );
  const remove = useCallback(() => model.setRule(kind, name, null), [model, kind, name]);
  return (
    <View style={styles.section}>
      <SelectField
        size={size}
        label={name}
        value={profileId}
        selectedDisplay={display}
        options={options}
        placeholder={t("collaboration.selectProfile")}
        emptyText={t("collaboration.chooseProfiles")}
        disabled={state.saving}
        onChange={change}
      />
      <Button variant="ghost" onPress={remove} disabled={state.saving}>
        {t("collaboration.removeRule")}
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { gap: 16 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  text: { color: theme.colors.foreground },
  error: { color: theme.colors.destructive },
}));

const CollaborationSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
