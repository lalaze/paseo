import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { EXECUTION_FALLBACK_LIMIT } from "@getpaseo/protocol/collaboration/schema";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import type { ModelSelection } from "./launch-model";
import type { openCollaborationLaunch } from "./launch-model";

type LaunchModel = ReturnType<typeof openCollaborationLaunch>;
type LaunchState = ReturnType<LaunchModel["getState"]>;

/** Ordered backup models for the execution agent. Empty leaves quota handoff manual. */
export function FallbackEditor({ model, state }: { model: LaunchModel; state: LaunchState }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const disabled = state.pending || state.agentsLocked;
  const issueCodes = useMemo(
    () => [...new Set(state.fallbackIssues.map((issue) => issue.code))],
    [state.fallbackIssues],
  );
  const add = useCallback(() => model.addFallback(), [model]);
  return (
    <View style={styles.section} testID="collaboration-fallbacks">
      <Text style={styles.label}>{t("collaboration.launch.fallbacks")}</Text>
      <Text style={styles.hint}>{t("collaboration.launch.fallbacksHint")}</Text>
      {issueCodes.map((code) => (
        <Text
          key={code}
          style={styles.error}
          accessibilityRole="alert"
          testID={`collaboration-fallback-issue-${code}`}
        >
          {t(`collaboration.launch.fallbackIssues.${code}`)}
        </Text>
      ))}
      {state.fallbacks.map((selection, index) => (
        <FallbackRow
          key={selection.rowKey ?? `${selection.provider}/${selection.model}`}
          index={index}
          selection={selection}
          model={model}
          state={state}
          disabled={disabled}
          size={size}
          compact={compact}
        />
      ))}
      <Button
        onPress={add}
        variant="outline"
        size={size}
        disabled={disabled || state.fallbacks.length >= EXECUTION_FALLBACK_LIMIT}
        testID="collaboration-fallback-add"
      >
        {t("collaboration.launch.addFallback")}
      </Button>
    </View>
  );
}

function FallbackRow({
  index,
  selection,
  model,
  state,
  disabled,
  size,
  compact,
}: {
  index: number;
  selection: ModelSelection;
  model: LaunchModel;
  state: LaunchState;
  disabled: boolean;
  size: "sm" | "md";
  compact: boolean;
}) {
  const { t } = useTranslation();
  const providerDisplay = useMemo(() => {
    if (!selection.provider) return null;
    const option = state.providerOptions.find((entry) => entry.value === selection.provider);
    return { label: option?.label ?? selection.providerLabel };
  }, [selection.provider, selection.providerLabel, state.providerOptions]);
  const modelDisplay = useMemo(() => {
    if (!selection.model) return null;
    const option = state.fallbackModelOptions[index]?.find(
      (entry) => entry.value === selection.model,
    );
    return { label: option?.label ?? selection.modelLabel };
  }, [index, selection.model, selection.modelLabel, state.fallbackModelOptions]);
  const thinkingOptions = useMemo(
    () => [
      {
        id: "",
        value: "",
        label: t("delegation.providerDefaults"),
        testID: `collaboration-fallback-${index}-thinking-default`,
      },
      ...(state.fallbackThinkingOptions[index] ?? []),
    ],
    [index, state.fallbackThinkingOptions, t],
  );
  const thinkingDisplay = useMemo(
    () => ({
      label: selection.thinkingOptionId
        ? (selection.thinkingOptionLabel ??
          formatThinkingOptionLabel({ id: selection.thinkingOptionId }))
        : t("delegation.providerDefaults"),
    }),
    [selection.thinkingOptionId, selection.thinkingOptionLabel, t],
  );
  const changeProvider = useCallback(
    (value: string, display: { label: string }) =>
      model.selectFallbackProvider(index, value, display.label),
    [index, model],
  );
  const changeModel = useCallback(
    (value: string, display: { label: string }) =>
      model.selectFallbackModel(index, value, display.label),
    [index, model],
  );
  const changeThinking = useCallback(
    (value: string, display: { label: string }) =>
      model.selectFallbackThinking(index, value, display.label),
    [index, model],
  );
  const remove = useCallback(() => model.removeFallback(index), [index, model]);
  const moveUp = useCallback(() => model.moveFallback(index, -1), [index, model]);
  const moveDown = useCallback(() => model.moveFallback(index, 1), [index, model]);
  const showThinking =
    (state.fallbackThinkingOptions[index]?.length ?? 0) > 0 || Boolean(selection.thinkingOptionId);
  return (
    <View style={styles.row} testID={`collaboration-fallback-${index}`}>
      <View style={[styles.fields, compact && styles.compactFields]}>
        <View style={styles.field}>
          <SelectField
            field={false}
            size={size}
            label={t("collaboration.launch.provider")}
            triggerTestID={`collaboration-fallback-${index}-provider`}
            value={selection.provider || null}
            selectedDisplay={providerDisplay}
            options={state.providerOptions}
            onChange={changeProvider}
            disabled={disabled}
            searchable
            placeholder={t("collaboration.launch.provider")}
            emptyText={t("collaboration.launch.noProviders")}
          />
        </View>
        {selection.provider ? (
          <View style={styles.field}>
            <SelectField
              field={false}
              size={size}
              label={t("collaboration.launch.model")}
              triggerTestID={`collaboration-fallback-${index}-model`}
              value={selection.model || null}
              selectedDisplay={modelDisplay}
              options={state.fallbackModelOptions[index] ?? []}
              onChange={changeModel}
              disabled={disabled}
              searchable
              placeholder={t("collaboration.launch.model")}
              emptyText={t("collaboration.launch.noModels")}
            />
          </View>
        ) : null}
        {selection.provider && showThinking ? (
          <View style={styles.field}>
            <SelectField
              field={false}
              size={size}
              label={t("agentControls.thinking.title")}
              triggerTestID={`collaboration-fallback-${index}-thinking`}
              value={selection.thinkingOptionId ?? ""}
              selectedDisplay={thinkingDisplay}
              options={thinkingOptions}
              onChange={changeThinking}
              disabled={disabled}
              placeholder={t("agentControls.thinking.select")}
              emptyText={t("common.empty.noResults")}
            />
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Button
          onPress={moveUp}
          variant="ghost"
          size={size}
          disabled={disabled || index === 0}
          accessibilityLabel={t("collaboration.launch.moveFallbackUp")}
          testID={`collaboration-fallback-${index}-up`}
        >
          {t("collaboration.launch.moveFallbackUp")}
        </Button>
        <Button
          onPress={moveDown}
          variant="ghost"
          size={size}
          disabled={disabled || index === state.fallbacks.length - 1}
          accessibilityLabel={t("collaboration.launch.moveFallbackDown")}
          testID={`collaboration-fallback-${index}-down`}
        >
          {t("collaboration.launch.moveFallbackDown")}
        </Button>
        <Button
          onPress={remove}
          variant="ghost"
          size={size}
          disabled={disabled}
          accessibilityLabel={t("collaboration.launch.removeFallback")}
          testID={`collaboration-fallback-${index}-remove`}
        >
          {t("collaboration.launch.removeFallback")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[2] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  row: { gap: theme.spacing[2] },
  fields: { flexDirection: "row", gap: theme.spacing[2] },
  compactFields: { flexDirection: "column" },
  field: { flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
}));
