import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { RolePrompts } from "@getpaseo/protocol/collaboration/schema";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildCollaborationHistoryRoute } from "@/utils/host-routes";
import { openCollaborationSettings } from "./settings-model";
import { useCollaboration } from "./use-collaboration";
import { useCollaborationLaunchStore } from "./launch-store";

const emptyPrompts: RolePrompts = {};

export function CollaborationPage({ serverId }: { serverId: string }) {
  return <CollaborationHostPage key={serverId} serverId={serverId} />;
}
function CollaborationHostPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { client, query, command, supportsInlineModels } = useCollaboration(serverId);
  const { mutateAsync } = command;
  const compact = useIsCompactFormFactor();
  const openHistory = useCallback(() => {
    router.push(buildCollaborationHistoryRoute(serverId));
  }, [serverId]);
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
    async (prompts: RolePrompts, base: RolePrompts) => {
      await mutateAsync({ name: "prompts.save", input: { prompts, base } });
    },
    [mutateAsync],
  );
  if (!client || query.isPending) return <Spinner />;
  const error = query.error?.message ?? query.data?.error;
  if (error)
    return (
      <View style={styles.section}>
        <Text style={styles.error}>{error}</Text>
        <Button onPress={retry}>{t("collaboration.retry")}</Button>
      </View>
    );
  if (!query.data) return null;
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
      {supportsInlineModels ? (
        <SettingsEditor
          initial={query.data.rolePrompts ?? emptyPrompts}
          save={save}
          afterSave={returningToChat ? returnToChat : undefined}
        />
      ) : (
        <Text style={styles.text}>{t("collaboration.launchErrors.updateHost")}</Text>
      )}
    </View>
  );
}
interface SettingsEditorProps {
  initial: RolePrompts;
  save: (prompts: RolePrompts, base: RolePrompts) => Promise<void>;
  afterSave?: () => Promise<void>;
}
function SettingsEditor({ initial, save, afterSave }: SettingsEditorProps) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() => openCollaborationSettings(initial));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const submit = useCallback(() => {
    void model.save(save, afterSave);
  }, [model, save, afterSave]);
  return (
    <SettingsSection title={t("collaboration.launch.prompts")}>
      <View style={styles.section}>
        {(["plan", "execute", "review"] as const).map((role) => (
          <PromptField key={role} role={role} model={model} state={state} size={size} />
        ))}
        {state.error && (
          <Text style={styles.error} accessibilityRole="alert">
            {state.error}
          </Text>
        )}
        {state.saved && <Text style={styles.text}>{t("collaboration.saved")}</Text>}
        <Button loading={state.saving} disabled={state.saving} onPress={submit}>
          {t("collaboration.save")}
        </Button>
      </View>
    </SettingsSection>
  );
}
type SettingsModel = ReturnType<typeof openCollaborationSettings>;
interface PromptFieldProps {
  role: keyof RolePrompts;
  model: SettingsModel;
  state: ReturnType<SettingsModel["getState"]>;
  size: "sm" | "md";
}
function PromptField({ role, model, state, size }: PromptFieldProps) {
  const { t } = useTranslation();
  const change = useCallback((value: string) => model.setPrompt(role, value), [model, role]);
  return (
    <Field label={t(`collaboration.${role}`)}>
      <FormTextInput
        size={size}
        multiline
        accessibilityLabel={t(`collaboration.${role}`)}
        initialValue={state.prompts[role] ?? ""}
        editable={!state.saving}
        onChangeText={change}
      />
    </Field>
  );
}
const Spinner = withUnistyles(LoadingSpinner, (theme) => ({ color: theme.colors.foregroundMuted }));
const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[4] },
  text: { color: theme.colors.foreground },
  error: { color: theme.colors.destructive },
}));
