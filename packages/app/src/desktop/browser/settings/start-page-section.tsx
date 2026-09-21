import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useBrowserStore } from "@/desktop/browser/store";
import { parseBrowserStartPageUrl } from "@/desktop/browser/store/state";

export function BrowserStartPageSection() {
  const hydrated = useSyncExternalStore(
    useBrowserStore.persist.onFinishHydration,
    useBrowserStore.persist.hasHydrated,
    useBrowserStore.persist.hasHydrated,
  );
  return hydrated ? <StartPageForm /> : null;
}

function StartPageForm() {
  const { t } = useTranslation();
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const startPageUrl = useBrowserStore((state) => state.startPageUrl);
  const setStartPageUrl = useBrowserStore((state) => state.setStartPageUrl);
  const [draft, setDraft] = useState(startPageUrl);
  const input = useRef<EditingTextInputHandle>(null);
  const url = parseBrowserStartPageUrl(draft);
  const { mutate: save, isPending } = useMutation({
    mutationFn: setStartPageUrl,
    onSuccess: (_result, savedUrl) => {
      input.current?.replaceText(savedUrl);
      setDraft(savedUrl);
      toast.show(t("settings.general.browserStartPage.saved"), { variant: "success" });
    },
    onError: () => toast.error(t("settings.general.browserStartPage.saveError")),
  });

  const submit = useCallback(() => {
    if (url && !isPending) save(url);
  }, [url, isPending, save]);

  return (
    <SettingsSection title={t("settings.general.browserStartPage.title")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.general.browserStartPage.url")}
          error={url === null ? t("settings.general.browserStartPage.invalidUrl") : undefined}
        >
          <View style={styles.controls}>
            <FormTextInput
              ref={input}
              initialValue={startPageUrl}
              onChangeText={setDraft}
              onSubmitEditing={submit}
              accessibilityLabel={t("settings.general.browserStartPage.url")}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!isPending}
              size={compact ? "md" : "sm"}
              style={styles.input}
              testID="browser-start-page-url"
            />
            <Button
              variant="outline"
              size="sm"
              onPress={submit}
              disabled={url === null || isPending}
              loading={isPending}
            >
              {t("common.actions.save")}
            </Button>
          </View>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], maxWidth: "100%" },
  input: { width: 280, maxWidth: "100%", flexShrink: 1 },
}));
