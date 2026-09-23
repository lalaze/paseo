import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Keyboard, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CollaborationMode } from "@getpaseo/protocol/collaboration/schema";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { enableCollaboration, type CollaborationTarget } from "./launch";
import { openCollaborationLaunch, type LaunchSnapshot } from "./launch-model";
import { closeCollaborationLaunch, useCollaborationLaunchStore } from "./launch-store";
import { useCollaboration } from "./use-collaboration";

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
  const header = useMemo(() => ({ title: t("collaboration.chooseMode") }), [t]);
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
        desktopMaxWidth={520}
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
  const header = useMemo(() => ({ title: t("collaboration.chooseMode") }), [t]);
  const options = useMemo(
    () => [
      {
        value: "full" as const,
        label: t("collaboration.modes.full"),
        disabled: state.locked || state.pending,
        testID: "collaboration-mode-full",
      },
      {
        value: "execute_review" as const,
        label: t("collaboration.modes.execute_review"),
        disabled: state.locked || state.pending || !state.supportsExecuteReview,
        testID: "collaboration-mode-execute-review",
      },
    ],
    [t, state.locked, state.pending, state.supportsExecuteReview],
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
    if (!model.getState().pending) closeCollaborationLaunch();
  }, [model]);
  const start = useCallback(() => {
    void model.start(async (mode) => {
      await enableCollaboration({ ...target, mode });
      closeCollaborationLaunch();
    });
  }, [model, target]);
  const unsetReviewer =
    state.mode === "execute_review"
      ? t("collaboration.selectProfile")
      : t("collaboration.sameReviewer");
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={close}
      desktopMaxWidth={520}
      testID="collaboration-mode-dialog"
    >
      <View style={styles.content}>
        <SegmentedControl options={options} value={state.mode} onValueChange={select} size={size} />
        <Text style={styles.text}>{t(`collaboration.modeDescriptions.${state.mode}`)}</Text>
        {target.goal && <Text style={styles.text}>{target.goal}</Text>}
        {!state.locked && (
          <View style={styles.profiles}>
            <Text style={styles.text}>
              {t("collaboration.workerProfileId")}:{" "}
              {state.worker ?? t("collaboration.selectProfile")}
            </Text>
            <Text style={styles.text}>
              {t("collaboration.reviewerProfileId")}: {state.reviewer ?? unsetReviewer}
            </Text>
          </View>
        )}
        {state.locked && <Text style={styles.text}>{t("collaboration.modeLocked")}</Text>}
        {!state.supportsExecuteReview && (
          <Text style={styles.text}>{t("collaboration.launchErrors.updateHost")}</Text>
        )}
        {state.blocked && (
          <Text style={styles.error}>{t(`collaboration.launchErrors.${state.blocked}`)}</Text>
        )}
        {state.error && <Text style={styles.error}>{state.error}</Text>}
        <View style={styles.actions}>
          <Button
            onPress={start}
            size={size}
            disabled={!state.canContinue}
            loading={state.pending}
            testID="collaboration-continue"
          >
            {t("collaboration.continue")}
          </Button>
          <Button onPress={close} size={size} disabled={state.pending} variant="ghost">
            {t("common.actions.cancel")}
          </Button>
          {!state.locked && (
            <Button onPress={onConfigure} size={size} disabled={state.pending} variant="ghost">
              {t("collaboration.configure")}
            </Button>
          )}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const Spinner = withUnistyles(LoadingSpinner, (theme) => ({ color: theme.colors.foregroundMuted }));
const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[4] },
  profiles: { gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
