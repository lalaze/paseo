import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { LaunchRole, ModelSelection } from "./launch-model";
import type { openCollaborationLaunch } from "./launch-model";

type LaunchState = ReturnType<ReturnType<typeof openCollaborationLaunch>["getState"]>;

/** The last setup on this host, so a new task starts with one tap; Change opens the full form. */
export function LaunchSummary({
  state,
  loading,
  onEdit,
}: {
  state: LaunchState;
  loading: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const roles: LaunchRole[] = state.showDirector
    ? ["director", "worker", "reviewer"]
    : ["worker", "reviewer"];
  const change = useMemo(
    () => (
      <Button
        onPress={onEdit}
        size={size}
        variant="ghost"
        disabled={state.pending}
        testID="collaboration-launch-edit"
      >
        {t("collaboration.launch.change")}
      </Button>
    ),
    [onEdit, size, state.pending, t],
  );
  return (
    <SettingsSection title={t("collaboration.launch.lastSetup")} flush trailing={change}>
      {loading ? (
        <View style={styles.loading}>
          <Spinner />
        </View>
      ) : (
        <View style={styles.rows} testID="collaboration-launch-summary">
          <Text style={styles.primary}>
            {`${t(`collaboration.modes.${state.mode}`)} · ${t(`newWorkspace.isolation.${state.isolation}`)}`}
          </Text>
          {roles.map((role) => (
            <Text key={role} style={styles.secondary}>
              {`${t(`collaboration.${role}ProfileId`)}: ${selectionLabel(state.selections[role]) ?? t("collaboration.sameReviewer")}`}
            </Text>
          ))}
          <Text style={styles.secondary}>
            {`${t("collaboration.maxReworks")}: ${state.maxReworks} · ${t("collaboration.launch.runHours", { count: Math.round(state.runTimeoutMs / 3600000) })}`}
          </Text>
        </View>
      )}
    </SettingsSection>
  );
}

function selectionLabel(selection: ModelSelection | null) {
  if (!selection) return null;
  return selection.modelLabel
    ? `${selection.providerLabel} · ${selection.modelLabel}`
    : selection.providerLabel;
}

const Spinner = withUnistyles(LoadingSpinner, (theme) => ({ color: theme.colors.foregroundMuted }));

const styles = StyleSheet.create((theme) => ({
  rows: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  loading: {
    paddingVertical: theme.spacing[3],
    alignItems: "flex-start",
  },
  primary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  secondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
