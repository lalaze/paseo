import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Circle, CircleDot } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { CollaborationMode } from "@getpaseo/protocol/collaboration/schema";
import { isWeb } from "@/constants/platform";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const modes: CollaborationMode[] = ["full", "execute_review"];
const EmptyRadio = withUnistyles(Circle);
const SelectedRadio = withUnistyles(CircleDot);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function LaunchModeOptions({
  mode,
  disabled,
  supportsExecuteReview,
  onSelect,
}: {
  mode: CollaborationMode;
  disabled: boolean;
  supportsExecuteReview: boolean;
  onSelect: (mode: CollaborationMode) => void;
}) {
  const { t } = useTranslation();
  const refs = useRef<Partial<Record<CollaborationMode, View | null>>>({});
  const register = useCallback((value: CollaborationMode, node: View | null) => {
    refs.current[value] = node;
  }, []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (
        disabled ||
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      let next: CollaborationMode = "full";
      if (supportsExecuteReview && event.key !== "Home") {
        if (event.key === "End" || mode === "full") next = "execute_review";
      }
      onSelect(next);
      refs.current[next]?.focus();
    },
    [disabled, supportsExecuteReview, mode, onSelect],
  );
  return (
    <View
      style={styles.options}
      accessibilityRole="radiogroup"
      accessibilityLabel={t("collaboration.chooseMode")}
      {...(isWeb ? { onKeyDown } : {})}
    >
      {modes.map((value) => (
        <ModeOption
          key={value}
          value={value}
          selected={mode === value}
          unavailable={value === "execute_review" && !supportsExecuteReview}
          disabled={disabled}
          onSelect={onSelect}
          register={register}
        />
      ))}
    </View>
  );
}

function ModeOption({
  value,
  selected,
  unavailable,
  disabled,
  onSelect,
  register,
}: {
  value: CollaborationMode;
  selected: boolean;
  unavailable: boolean;
  disabled: boolean;
  onSelect: (mode: CollaborationMode) => void;
  register: (mode: CollaborationMode, node: View | null) => void;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const inactive = disabled || unavailable;
  const ref = useCallback((node: View | null) => register(value, node), [register, value]);
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  const keyDown = useCallback(
    (event: KeyboardEvent) => {
      if (inactive || (event.key !== " " && event.key !== "Spacebar")) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(value);
    },
    [inactive, onSelect, value],
  );
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const accessibilityState = useMemo(
    () => ({ checked: selected, disabled: inactive }),
    [selected, inactive],
  );
  const optionStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.option,
      selected && styles.selected,
      !inactive && (hovered || pressed) && styles.hover,
      unavailable && styles.unavailable,
      focused && !inactive && styles.focused,
    ],
    [selected, inactive, unavailable, focused],
  );
  return (
    <View {...(isWeb ? { onKeyDown: keyDown } : {})}>
      <Pressable
        ref={ref}
        accessibilityRole="radio"
        accessibilityLabel={t(`collaboration.modes.${value}`)}
        accessibilityState={accessibilityState}
        aria-checked={selected}
        disabled={inactive}
        {...(isWeb ? { tabIndex: selected && !inactive ? 0 : -1 } : {})}
        onPress={select}
        onFocus={focus}
        onBlur={blur}
        testID={value === "full" ? "collaboration-mode-full" : "collaboration-mode-execute-review"}
        style={optionStyle}
      >
        <View style={styles.radio}>
          {selected ? (
            <SelectedRadio size={ICON_SIZE.lg} uniProps={foreground} />
          ) : (
            <EmptyRadio size={ICON_SIZE.lg} uniProps={muted} />
          )}
        </View>
        <View style={styles.copy}>
          <Text style={styles.title}>{t(`collaboration.modes.${value}`)}</Text>
          <Text style={styles.description}>{t(`collaboration.modeDescriptions.${value}`)}</Text>
          {unavailable && (
            <Text style={styles.description}>{t("collaboration.launchErrors.updateHost")}</Text>
          )}
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  options: { gap: theme.spacing[2] },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    minHeight: 76,
  },
  selected: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.foregroundMuted },
  hover: { backgroundColor: theme.colors.interactionHighlight },
  unavailable: { opacity: theme.opacity[50] },
  focused: createControlGeometry(theme).controlActive,
  radio: { flexShrink: 0 },
  copy: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    color: theme.colors.foregroundMuted,
  },
}));
