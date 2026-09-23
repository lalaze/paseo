import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Keyboard, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CollaborationMode } from "@getpaseo/protocol/collaboration/schema";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ChevronRight, ShieldCheck, UserRound } from "lucide-react-native";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { LaunchModeOptions } from "./launch-mode-options";
import { LaunchGoal } from "./launch-goal";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { enableCollaboration, type CollaborationTarget } from "./launch";
import { openCollaborationLaunch, type LaunchSnapshot } from "./launch-model";
import { closeCollaborationLaunch, useCollaborationLaunchStore } from "./launch-store";
import { useCollaboration } from "./use-collaboration";

const launchSnapPoints = ["75%", "90%"];

export function CollaborationLaunchHost() {
  const request = useCollaborationLaunchStore((state) => state.request);
  return request ? <LaunchDialog key={request.requestId} target={request} /> : null;
}

function LaunchDialog({ target }: { target: CollaborationTarget }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [origin] = useState(() => useCollaborationLaunchStore.getState().originPath ?? pathname);
  const configuring = useCollaborationLaunchStore((state) => state.configuring);
  const { client, query } = useCollaboration(target.serverId);
  const configPath = buildSettingsHostSectionRoute(target.serverId, "collaboration");
  const header = useMemo(
    () => ({
      title: t("collaboration.chooseMode"),
      subtitle: <Text style={styles.secondary}>{t("collaboration.launch.subtitle")}</Text>,
    }),
    [t],
  );
  useEffect(() => {
    useCollaborationLaunchStore.setState({ originPath: origin });
    Keyboard.dismiss();
  }, [origin]);
  useEffect(() => {
    if (pathname === origin) {
      useCollaborationLaunchStore.setState({ configuring: false });
    } else if (pathname !== configPath) {
      closeCollaborationLaunch();
    }
  }, [pathname, origin, configPath]);
  const configure = useCallback(() => {
    useCollaborationLaunchStore.setState({ configuring: true });
    router.push(configPath);
  }, [configPath]);
  const retry = useCallback(() => {
    void query.refetch();
  }, [query]);
  const snapshot = useMemo<LaunchSnapshot>(
    () => ({
      settings: query.data?.settings ?? null,
      conversation: query.data?.conversations.find((entry) =>
        target.agentId ? entry.agentId === target.agentId : entry.requestId === target.requestId,
      ),
      supportsExecuteReview:
        client?.getLastServerInfoMessage()?.features?.collaborationExecuteReview === true,
    }),
    [query.data, client, target.agentId, target.requestId],
  );
  const visible = pathname === origin && !configuring;
  const error = query.error?.message ?? query.data?.error;
  if (!query.data || query.data.error)
    return (
      <AdaptiveModalSheet
        header={header}
        visible={visible}
        onClose={closeCollaborationLaunch}
        desktopMaxWidth={560}
        snapPoints={launchSnapPoints}
      >
        {error ? (
          <View style={styles.content}>
            <Text style={styles.error}>{error}</Text>
            <Button onPress={retry}>{t("collaboration.retry")}</Button>
          </View>
        ) : (
          <Spinner />
        )}
      </AdaptiveModalSheet>
    );
  return (
    <ModePicker target={target} snapshot={snapshot} visible={visible} onConfigure={configure} />
  );
}

interface ModePickerProps {
  target: CollaborationTarget;
  snapshot: LaunchSnapshot;
  visible: boolean;
  onConfigure: () => void;
}

function ModePicker({ target, snapshot, visible, onConfigure }: ModePickerProps) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() => openCollaborationLaunch(snapshot, target.mode));
  useEffect(() => () => model.close(), [model]);
  const { settings, conversation, supportsExecuteReview } = snapshot;
  useEffect(
    () => model.applySnapshot({ settings, conversation, supportsExecuteReview }),
    [model, settings, conversation, supportsExecuteReview],
  );
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
    if (!model.getState().pending) closeCollaborationLaunch();
  }, [model, target.requestId]);
  const start = useCallback(() => {
    void model.start(async (mode) => {
      await enableCollaboration({ ...target, mode });
      closeCollaborationLaunch();
    });
  }, [model, target]);
  const needsConfiguration = state.primaryAction !== "continue";
  const reviewerMissing = state.mode === "execute_review" && !state.reviewer;
  const primaryLabel = t(
    {
      configureReviewer: "collaboration.launch.configureReviewer",
      configure: "collaboration.configure",
      continue: "collaboration.continue",
    }[state.primaryAction],
  );
  const manageChevron = useMemo(
    () => <ThemedChevron size={ICON_SIZE.sm} uniProps={mutedColor} />,
    [],
  );
  const manageProfiles = useMemo(
    () => (
      <Button
        onPress={onConfigure}
        size={size}
        variant="ghost"
        disabled={state.pending}
        trailing={manageChevron}
        testID="collaboration-manage-profiles"
      >
        {t("collaboration.launch.manage")}
      </Button>
    ),
    [onConfigure, size, state.pending, manageChevron, t],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
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
            onPress={needsConfiguration ? onConfigure : start}
            variant="default"
            style={styles.primary}
            textStyle={styles.primaryText}
            disabled={state.pending || (!needsConfiguration && !state.canContinue)}
            loading={state.pending}
            testID={needsConfiguration ? "collaboration-configure" : "collaboration-continue"}
          >
            {primaryLabel}
          </Button>
        </>
      }
    >
      <View style={styles.content}>
        <LaunchModeOptions
          mode={state.mode}
          disabled={state.locked || state.pending}
          supportsExecuteReview={state.supportsExecuteReview}
          onSelect={select}
        />
        {target.goal && <LaunchGoal goal={target.goal} />}
        {!state.locked && (
          <SettingsSection
            title={t("collaboration.launch.agents")}
            style={styles.profiles}
            flush
            trailing={manageProfiles}
          >
            <View>
              <View style={styles.profileRow} testID="collaboration-launch-worker">
                <ThemedUser size={ICON_SIZE.lg} uniProps={mutedColor} />
                <Text style={styles.role}>{t("collaboration.launch.worker")}</Text>
                <Text style={styles.profileName}>
                  {state.worker ?? t("collaboration.launch.unconfigured")}
                </Text>
              </View>
              <View
                style={[styles.profileRow, styles.reviewRow]}
                testID="collaboration-launch-reviewer"
              >
                <ThemedShield size={ICON_SIZE.lg} uniProps={mutedColor} />
                <Text style={styles.role}>{t("collaboration.launch.reviewer")}</Text>
                <View style={styles.profileValue}>
                  <Text style={[styles.text, reviewerMissing && styles.warning]}>
                    {state.reviewer ??
                      (reviewerMissing
                        ? t("collaboration.launch.unconfigured")
                        : t("collaboration.sameReviewer"))}
                  </Text>
                  {reviewerMissing && (
                    <Text style={styles.secondary}>{t("collaboration.launch.reviewerHint")}</Text>
                  )}
                </View>
              </View>
            </View>
          </SettingsSection>
        )}
        {state.locked && <Text style={styles.secondary}>{t("collaboration.modeLocked")}</Text>}
        {state.blocked === "configure" && (
          <Text style={styles.secondary}>{t("collaboration.launchErrors.configure")}</Text>
        )}
        {state.error && (
          <Text style={styles.error} accessibilityRole="alert">
            {state.error}
          </Text>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const Spinner = withUnistyles(LoadingSpinner, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedUser = withUnistyles(UserRound);
const ThemedShield = withUnistyles(ShieldCheck);
const ThemedChevron = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[6] },
  profiles: {
    paddingTop: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  reviewRow: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  role: {
    width: 72,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  profileValue: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
  profileName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  primary: { flexShrink: 1 },
  primaryText: { textAlign: "center" },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  secondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  warning: { color: theme.colors.statusWarning },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
