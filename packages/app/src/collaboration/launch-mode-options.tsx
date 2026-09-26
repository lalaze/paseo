import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Circle, CircleDot } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  CollaborationIsolation,
  CollaborationMode,
} from "@getpaseo/protocol/collaboration/schema";
import { isWeb } from "@/constants/platform";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const modes: CollaborationMode[] = ["full", "execute_review"];
const isolations: CollaborationIsolation[] = ["local", "worktree"];
const EmptyRadio = withUnistyles(Circle);
const SelectedRadio = withUnistyles(CircleDot);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const RADIO_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

function nextRadioIndex(key: string, index: number, count: number): number {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(count - 1, index + 1);
  return Math.max(0, index - 1);
}

interface RadioChoice<T extends string> {
  value: T;
  title: string;
  description: string;
  unavailable?: boolean;
  pending?: boolean;
  notice?: string;
  testID: string;
}

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
  const options = useMemo(
    () =>
      modes.map((value) => {
        const unavailable = value === "execute_review" && !supportsExecuteReview;
        return {
          value,
          title: t(`collaboration.modes.${value}`),
          description: t(`collaboration.modeDescriptions.${value}`),
          unavailable,
          notice: unavailable ? t("collaboration.launchErrors.updateHost") : undefined,
          testID:
            value === "full" ? "collaboration-mode-full" : "collaboration-mode-execute-review",
        };
      }),
    [supportsExecuteReview, t],
  );
  return (
    <RadioOptions
      label={t("collaboration.chooseMode")}
      value={mode}
      options={options}
      disabled={disabled}
      onSelect={onSelect}
    />
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
      isolations.map((value) => {
        const unavailable = value === "worktree" && supportsWorktree === false;
        return {
          value,
          title: t(`newWorkspace.isolation.${value}`),
          description: t(`collaboration.isolationDescriptions.${value}`),
          unavailable,
          pending: value === "worktree" && supportsWorktree === null,
          notice: unavailable ? t("collaboration.launchErrors.updateHostWorktree") : undefined,
          testID: `collaboration-isolation-${value}`,
        };
      }),
    [supportsWorktree, t],
  );
  return (
    <RadioOptions
      label={t("newWorkspace.isolation.label")}
      value={isolation}
      options={options}
      disabled={disabled}
      onSelect={onSelect}
    />
  );
}

function RadioOptions<T extends string>({
  label,
  value,
  options,
  disabled,
  onSelect,
}: {
  label: string;
  value: T;
  options: RadioChoice<T>[];
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  const refs = useRef<Partial<Record<string, View | null>>>({});
  const register = useCallback((option: string, node: View | null) => {
    refs.current[option] = node;
  }, []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const selectable = options.filter((option) => !option.unavailable && !option.pending);
      if (disabled || selectable.length === 0 || !RADIO_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const index = Math.max(
        0,
        selectable.findIndex((option) => option.value === value),
      );
      const next = selectable[nextRadioIndex(event.key, index, selectable.length)]?.value;
      if (!next || next === value) return;
      onSelect(next);
      refs.current[next]?.focus();
    },
    [disabled, onSelect, options, value],
  );
  return (
    <View
      style={styles.options}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      {...(isWeb ? { onKeyDown } : {})}
    >
      {options.map((option) => (
        <RadioOption
          key={option.value}
          option={option}
          selected={option.value === value}
          disabled={disabled}
          onSelect={onSelect}
          register={register}
        />
      ))}
    </View>
  );
}

function RadioOption<T extends string>({
  option,
  selected,
  disabled,
  onSelect,
  register,
}: {
  option: RadioChoice<T>;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: T) => void;
  register: (value: string, node: View | null) => void;
}) {
  const [focused, setFocused] = useState(false);
  const inactive = disabled || !!option.unavailable || !!option.pending;
  const ref = useCallback(
    (node: View | null) => register(option.value, node),
    [option.value, register],
  );
  const select = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  const keyDown = useCallback(
    (event: KeyboardEvent) => {
      if (inactive || (event.key !== " " && event.key !== "Spacebar")) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(option.value);
    },
    [inactive, onSelect, option.value],
  );
  const focus = useCallback(() => setFocused(true), []);
  const blur = useCallback(() => setFocused(false), []);
  const accessibilityState = useMemo(
    () => ({ checked: selected, disabled: inactive }),
    [inactive, selected],
  );
  const optionStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType) => [
      styles.option,
      selected && styles.selected,
      !inactive && (hovered || pressed) && styles.hover,
      option.unavailable && styles.unavailable,
      focused && !inactive && styles.focused,
    ],
    [focused, inactive, option.unavailable, selected],
  );
  return (
    <View {...(isWeb ? { onKeyDown: keyDown } : {})}>
      <Pressable
        ref={ref}
        accessibilityRole="radio"
        accessibilityLabel={option.title}
        accessibilityState={accessibilityState}
        aria-checked={selected}
        disabled={inactive}
        {...(isWeb ? { tabIndex: selected && !inactive ? 0 : -1 } : {})}
        onPress={select}
        onFocus={focus}
        onBlur={blur}
        testID={option.testID}
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
          <Text style={styles.title}>{option.title}</Text>
          <Text style={styles.description}>{option.description}</Text>
          {option.notice ? <Text style={styles.description}>{option.notice}</Text> : null}
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
