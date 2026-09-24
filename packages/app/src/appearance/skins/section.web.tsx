import { useCallback, useMemo, useRef, type ChangeEvent, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { SKIN_LIBRARY_KEY, SkinImportError, type SkinMetadata } from "./model";
import { MAX_SKIN_ARCHIVE_BYTES, readSkinPackage } from "./package";
import { prepareSkinImage, removeSkin, saveSkin, selectSkin } from "./storage.web";
import { useSkinLibrary } from "./use-library.web";

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  gap: 12,
};
const strengths = [0.15, 0.3, 0.65];
type RunSkinAction = (action: () => Promise<void>) => void;

interface SkinCardProps {
  skin: SkinMetadata;
  selected: boolean;
  disabled: boolean;
  run: RunSkinAction;
}
function SkinCard({ skin, selected, disabled, run }: SkinCardProps) {
  const { t } = useTranslation();
  const { updateSettings } = useAppSettings();
  const select = useCallback(
    () =>
      run(async () => {
        await selectSkin(skin.id, skin.strength);
        await updateSettings({ bingWallpaperEnabled: false });
      }),
    [run, skin.id, skin.strength, updateSettings],
  );
  const imageStyle = useMemo<CSSProperties>(
    () => ({
      display: "block",
      width: "100%",
      height: 94,
      objectFit: "cover",
      objectPosition: `${skin.focusX * 100}% ${skin.focusY * 100}%`,
    }),
    [skin.focusX, skin.focusY],
  );
  const state = useMemo(() => ({ selected, disabled }), [selected, disabled]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("settings.appearance.skins.apply", { name: skin.name })}
      accessibilityState={state}
      disabled={disabled}
      onPress={select}
      style={[styles.thumbnail, selected ? styles.selected : null]}
    >
      <img src={skin.thumbnail} alt="" style={imageStyle} />
      <Text style={styles.name}>{skin.name}</Text>
    </Pressable>
  );
}

interface StrengthButtonProps {
  skinId: string;
  strength: number;
  selected: boolean;
  disabled: boolean;
  run: RunSkinAction;
}
function StrengthButton({ skinId, strength, selected, disabled, run }: StrengthButtonProps) {
  const select = useCallback(
    () => run(() => selectSkin(skinId, strength)),
    [run, skinId, strength],
  );
  return (
    <Button
      size="sm"
      variant={selected ? "secondary" : "outline"}
      disabled={disabled}
      onPress={select}
    >{`${Math.round(strength * 100)}%`}</Button>
  );
}

export function ImageSkinsSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const library = useSkinLibrary();
  const { settings, updateSettings } = useAppSettings();
  const input = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: (action: () => Promise<void>) => action(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SKIN_LIBRARY_KEY }),
  });
  const { mutate: run, isPending } = mutation;
  const data = library.data;
  const active = settings.bingWallpaperEnabled ? null : data?.active;
  const pickFile = useCallback(() => input.current?.click(), []);
  const browseGallery = useCallback(
    () => run(() => Linking.openURL("https://dreamskin.cc/")),
    [run],
  );
  const restore = useCallback(() => run(() => selectSkin(null, 0.3)), [run]);
  const { refetch } = library;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const remove = useCallback(() => {
    if (active) run(() => removeSkin(active.id));
  }, [active, run]);
  const importFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      run(async () => {
        if (file.size > MAX_SKIN_ARCHIVE_BYTES)
          throw new SkinImportError("Theme ZIP exceeds 32 MB.");
        const imported = await readSkinPackage(new Uint8Array(await file.arrayBuffer()));
        const ready = await prepareSkinImage(imported);
        await saveSkin(ready);
        await updateSettings({ bingWallpaperEnabled: false });
      });
    },
    [run, updateSettings],
  );

  return (
    <SettingsSection title={t("settings.appearance.skins.title")}>
      <View style={[settingsStyles.card, styles.card]}>
        <Text style={settingsStyles.rowHint}>{t("settings.appearance.skins.description")}</Text>
        <input
          ref={input}
          data-testid="skin-file-input"
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={importFile}
        />
        <View style={styles.actions}>
          <Button size="sm" disabled={isPending} onPress={pickFile}>
            {t("settings.appearance.skins.import")}
          </Button>
          <Button size="sm" variant="outline" disabled={isPending} onPress={browseGallery}>
            {t("settings.appearance.skins.gallery")}
          </Button>
          <Button size="sm" variant="outline" disabled={!active || isPending} onPress={restore}>
            {t("settings.appearance.skins.restore")}
          </Button>
        </View>
        {isPending ? (
          <Text role="status" style={styles.message}>
            {t("settings.appearance.skins.pending")}
          </Text>
        ) : null}
        {mutation.isError ? (
          <Text role="alert" style={styles.error}>
            {t("settings.appearance.skins.failed", { reason: mutation.error.message })}
          </Text>
        ) : null}
        {library.isError ? (
          <Button onPress={retry}>{t("settings.appearance.skins.retry")}</Button>
        ) : null}
        {data?.skins.length === 0 ? (
          <Text style={settingsStyles.rowHint}>{t("settings.appearance.skins.empty")}</Text>
        ) : null}
        <div style={gridStyle}>
          {data?.skins.map((skin) => (
            <SkinCard
              key={skin.id}
              skin={skin}
              selected={active?.id === skin.id}
              disabled={isPending}
              run={run}
            />
          ))}
        </div>
        {active ? (
          <View style={styles.details}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.appearance.skins.active", { name: active.name })}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("settings.appearance.skins.strength")}</Text>
            <View style={styles.actions}>
              {strengths.map((strength) => (
                <StrengthButton
                  key={strength}
                  skinId={active.id}
                  strength={strength}
                  selected={data?.strength === strength}
                  disabled={isPending}
                  run={run}
                />
              ))}
            </View>
            {active.author ? (
              <Text style={settingsStyles.rowHint}>
                {t("settings.appearance.skins.author", { name: active.author })}
              </Text>
            ) : null}
            {active.license ? (
              <Text selectable style={styles.message}>
                {active.license}
              </Text>
            ) : null}
            {active.provenance ? (
              <Text style={settingsStyles.rowHint}>{active.provenance}</Text>
            ) : null}
            <Button size="sm" variant="outline" disabled={isPending} onPress={remove}>
              {t("settings.appearance.skins.remove")}
            </Button>
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: { padding: theme.spacing[4], gap: theme.spacing[3] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  details: { gap: theme.spacing[2] },
  thumbnail: {
    overflow: "hidden",
    borderRadius: theme.borderRadius.md,
    borderWidth: 2,
    borderColor: "transparent",
  },
  selected: { borderColor: theme.colors.accentBright },
  name: {
    padding: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
