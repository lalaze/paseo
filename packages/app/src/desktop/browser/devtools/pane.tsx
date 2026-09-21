import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

export function DevToolsPane(_props: { browserId: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container}>
      <Text style={styles.message}>{t("workspace.browser.unavailable.subtitle")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
