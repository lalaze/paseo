import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  CollaborationIsolation,
  CollaborationMode,
} from "@getpaseo/protocol/collaboration/schema";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";

const isolations: CollaborationIsolation[] = ["local", "worktree"];

interface Choice<T extends string> extends SegmentedControlOption<T> {
  description: string;
  notice?: string;
}

export function LaunchModeOptions({
  mode,
  disabled,
  onSelect,
}: {
  mode: CollaborationMode;
  disabled: boolean;
  onSelect: (mode: CollaborationMode) => void;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(
    (enabled: boolean) => onSelect(enabled ? "full" : "execute_review"),
    [onSelect],
  );
  return (
    <View style={[settingsStyles.row, styles.planningRow]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("collaboration.planFirst")}</Text>
        <Text style={settingsStyles.rowHint}>{t("collaboration.planFirstHint")}</Text>
      </View>
      <Switch
        value={mode === "full"}
        onValueChange={toggle}
        disabled={disabled}
        accessibilityLabel={t("collaboration.planFirst")}
        testID="collaboration-plan-first"
      />
    </View>
  );
}

export function LaunchIsolationOptions({
  isolation,
  disabled,
  supportsWorktree,
  onSelect,
}: {
  isolation: CollaborationIsolation;
  disabled: boolean;
  /** Null while the host has not reported its features. */
  supportsWorktree: boolean | null;
  onSelect: (isolation: CollaborationIsolation) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      isolations.map((value): Choice<CollaborationIsolation> => {
        const unavailable = value === "worktree" && supportsWorktree === false;
        const pending = value === "worktree" && supportsWorktree === null;
        return {
          value,
          label: t(`newWorkspace.isolation.${value}`),
          description: t(`collaboration.isolationDescriptions.${value}`),
          disabled: disabled || unavailable || pending,
          notice: unavailable ? t("collaboration.launchErrors.updateHostWorktree") : undefined,
          testID: `collaboration-isolation-${value}`,
        };
      }),
    [disabled, supportsWorktree, t],
  );
  return (
    <ChoiceControl
      value={isolation}
      options={options}
      onSelect={onSelect}
      testID="collaboration-isolation"
    />
  );
}

/** One segmented row; only the selected choice's description is shown, plus any update notice. */
function ChoiceControl<T extends string>({
  value,
  options,
  onSelect,
  testID,
}: {
  value: T;
  options: Choice<T>[];
  onSelect: (value: T) => void;
  testID: string;
}) {
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const selected = options.find((option) => option.value === value);
  const notices = options.flatMap((option) => (option.notice ? [option.notice] : []));
  return (
    <View style={styles.choice}>
      <SegmentedControl
        size={size}
        value={value}
        options={options}
        onValueChange={onSelect}
        testID={testID}
      />
      {selected ? <Text style={styles.description}>{selected.description}</Text> : null}
      {notices.map((notice) => (
        <Text key={notice} style={styles.description}>
          {notice}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  planningRow: { paddingHorizontal: 0 },
  choice: { alignItems: "flex-start", gap: theme.spacing[2] },
  description: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foregroundMuted,
  },
}));
