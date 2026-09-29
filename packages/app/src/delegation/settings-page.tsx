import { useCallback, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type {
  MutableDaemonConfigPatch,
  MutableDelegationConfig,
} from "@getpaseo/protocol/messages";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";

type AgentDefaults = MutableDelegationConfig["agentDefaults"];
type DepthOption = "1" | "2" | "3";

const DEFAULT_DELEGATION: MutableDelegationConfig = {
  enabled: true,
  depthLimit: 1,
  agentDefaults: {},
};

export function DelegationSettingsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "delegation");
  const { config, isLoading, patchConfig } = useDaemonConfig(serverId);
  const snapshot = useProvidersSnapshot(serverId);
  const [isSaving, setIsSaving] = useState(false);
  const providers = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const delegation = config?.delegation ?? DEFAULT_DELEGATION;

  const save = useCallback(
    async (patch: NonNullable<MutableDaemonConfigPatch["delegation"]>) => {
      setIsSaving(true);
      try {
        await patchConfig({ delegation: patch });
      } catch (error) {
        Alert.alert(
          t("delegation.saveError"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, t],
  );

  const depthOptions = useMemo(
    () =>
      (["1", "2", "3"] as const).map((value) => ({
        value,
        label: value,
      })),
    [],
  );
  const handleEnabledChange = useCallback((enabled: boolean) => void save({ enabled }), [save]);
  const handleDepthChange = useCallback(
    (value: DepthOption) => void save({ depthLimit: Number(value) }),
    [save],
  );
  const saveAgentDefaults = useCallback(
    (agentDefaults: AgentDefaults) => void save({ agentDefaults }),
    [save],
  );

  if (!supported) {
    return (
      <SettingsSection title={t("delegation.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("delegation.updateHost")}</Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  if (isLoading || !config) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  const depthValue = String(Math.min(delegation.depthLimit, 3)) as DepthOption;

  return (
    <>
      <SettingsSection
        title={t("delegation.title")}
        info={t("delegation.description")}
        testID="delegation-settings"
      >
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("delegation.enabled")}</Text>
              <Text style={settingsStyles.rowHint}>{t("delegation.enabledHint")}</Text>
            </View>
            <Switch
              value={delegation.enabled}
              onValueChange={handleEnabledChange}
              disabled={isSaving}
              accessibilityLabel={t("delegation.enabled")}
              testID="delegation-enabled"
            />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("delegation.depth")}</Text>
              <Text style={settingsStyles.rowHint}>{t("delegation.depthHint")}</Text>
            </View>
            <SegmentedControl
              options={depthOptions}
              value={depthValue}
              onValueChange={handleDepthChange}
              size="sm"
              testID="delegation-depth"
            />
          </View>
        </View>
      </SettingsSection>
      <SettingsSection
        title={t("delegation.agentDefaults")}
        info={t("delegation.agentDefaultsDescription")}
      >
        <View style={settingsStyles.card}>
          {providers.map((provider, index) => (
            <AgentDefaultsRow
              key={provider.id}
              serverId={serverId}
              provider={provider}
              entry={snapshot.entries?.find((entry) => entry.provider === provider.id)}
              agentDefaults={delegation.agentDefaults}
              bordered={index > 0}
              disabled={isSaving}
              isLoadingModels={snapshot.isLoading || snapshot.isFetching}
              onRefresh={snapshot.refetchIfStale}
              onSave={saveAgentDefaults}
            />
          ))}
        </View>
      </SettingsSection>
    </>
  );
}

interface AgentDefaultsRowProps {
  serverId: string;
  provider: ProviderSelectorProvider;
  entry: ProviderSnapshotEntry | undefined;
  agentDefaults: AgentDefaults;
  bordered: boolean;
  disabled: boolean;
  isLoadingModels: boolean;
  onRefresh: (provider?: string) => void;
  onSave: (agentDefaults: AgentDefaults) => void;
}

function AgentDefaultsRow({
  serverId,
  provider,
  entry,
  agentDefaults,
  bordered,
  disabled,
  isLoadingModels,
  onRefresh,
  onSave,
}: AgentDefaultsRowProps) {
  const { t } = useTranslation();
  const defaults = agentDefaults[provider.id];
  const modes = entry?.modes ?? [];
  const selectedMode = modes.find((mode) => mode.id === defaults?.modeId);
  const singleProvider = useMemo(() => [provider], [provider]);

  const update = useCallback(
    (next: { model?: string; modeId?: string }) => {
      const merged = { ...defaults, ...next };
      const cleaned = {
        ...(merged.model ? { model: merged.model } : {}),
        ...(merged.modeId ? { modeId: merged.modeId } : {}),
        ...(merged.thinkingOptionId ? { thinkingOptionId: merged.thinkingOptionId } : {}),
      };
      const nextDefaults = { ...agentDefaults };
      if (Object.keys(cleaned).length > 0) nextDefaults[provider.id] = cleaned;
      else delete nextDefaults[provider.id];
      onSave(nextDefaults);
    },
    [agentDefaults, defaults, onSave, provider.id],
  );
  const handleModelSelect = useCallback(
    (_provider: AgentProvider, model: string) => update({ model }),
    [update],
  );
  const handleReset = useCallback(() => {
    const nextDefaults = { ...agentDefaults };
    delete nextDefaults[provider.id];
    onSave(nextDefaults);
  }, [agentDefaults, onSave, provider.id]);
  const handleOpen = useCallback(() => onRefresh(provider.id), [onRefresh, provider.id]);

  return (
    <View style={[settingsStyles.row, bordered && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{provider.label}</Text>
        <Text style={settingsStyles.rowHint}>
          {defaults ? t("delegation.customDefaults") : t("delegation.providerDefaults")}
        </Text>
      </View>
      <View style={styles.controls}>
        <CombinedModelSelector
          providers={singleProvider}
          selectedProvider={provider.id}
          selectedModel={defaults?.model ?? ""}
          onSelect={handleModelSelect}
          isLoading={isLoadingModels}
          onOpen={handleOpen}
          disabled={disabled}
          serverId={serverId}
          desktopPlacement="bottom-start"
          desktopMinWidth={320}
        />
        {modes.length > 0 ? (
          <DropdownMenu>
            <DropdownTrigger
              accessibilityRole="button"
              accessibilityLabel={t("delegation.mode")}
              disabled={disabled}
            >
              {selectedMode?.label ?? t("delegation.defaultMode")}
            </DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" width={220}>
              <ModeMenuItem
                label={t("delegation.defaultMode")}
                selected={!selectedMode}
                onSelect={update}
              />
              {modes.map((mode) => (
                <ModeMenuItem
                  key={mode.id}
                  modeId={mode.id}
                  label={mode.label}
                  selected={mode.id === selectedMode?.id}
                  onSelect={update}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {defaults ? (
          <Button variant="ghost" size="sm" onPress={handleReset} disabled={disabled}>
            {t("delegation.reset")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

function ModeMenuItem({
  modeId,
  label,
  selected,
  onSelect,
}: {
  modeId?: string;
  label: string;
  selected: boolean;
  onSelect: (next: { modeId?: string }) => void;
}) {
  const handleSelect = useCallback(() => onSelect({ modeId: modeId ?? "" }), [modeId, onSelect]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
}));
