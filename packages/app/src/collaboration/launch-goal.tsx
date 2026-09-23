import { useCallback, useMemo, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";

export function LaunchGoal({ goal }: { goal: string }) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [expanded, setExpanded] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  const [clampedHeight, setClampedHeight] = useState(0);
  const measureFull = useCallback(
    (event: LayoutChangeEvent) => setFullHeight(event.nativeEvent.layout.height),
    [],
  );
  const measureClamped = useCallback(
    (event: LayoutChangeEvent) => setClampedHeight(event.nativeEvent.layout.height),
    [],
  );
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const overflowing = fullHeight > clampedHeight + 1;
  return (
    <SettingsSection title={t("collaboration.launch.goal")} flush>
      <View>
        {/* Measure both layouts at the live width on native and web, including font scaling. */}
        <View
          style={styles.measure}
          pointerEvents="none"
          aria-hidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={styles.text} onLayout={measureFull}>
            {goal}
          </Text>
          <Text style={styles.text} numberOfLines={3} onLayout={measureClamped}>
            {goal}
          </Text>
        </View>
        <Text
          style={styles.text}
          numberOfLines={expanded ? undefined : 3}
          testID="collaboration-launch-goal"
        >
          {goal}
        </Text>
      </View>
      {overflowing && (
        <Button
          variant="ghost"
          size={size}
          style={styles.toggle}
          onPress={toggle}
          accessibilityState={accessibilityState}
          aria-expanded={expanded}
          testID="collaboration-goal-toggle"
        >
          {t(expanded ? "collaboration.history.collapse" : "collaboration.history.expand")}
        </Button>
      )}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
    color: theme.colors.foregroundMuted,
  },
  measure: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 0,
    overflow: "hidden",
    opacity: 0,
  },
  toggle: { alignSelf: "flex-start" },
}));
