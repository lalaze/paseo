import { useCallback, useEffect, useReducer, useRef, type CSSProperties } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { useBrowserStore } from "@/desktop/browser/store";
import { usePaneFocus } from "@/panels/pane-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getOverlayRoot, hasActiveWebOverlay } from "@/lib/overlay-root";

interface DevToolsState {
  status: "loading" | "ready" | "failed";
  revision: number;
}

const hostStyle: CSSProperties = { position: "absolute", inset: 0 };

function reduceDevTools(state: DevToolsState, action: "retry" | "ready" | "failed"): DevToolsState {
  if (action === "retry") return { status: "loading", revision: state.revision + 1 };
  return { ...state, status: action };
}

export function DevToolsPane({ browserId }: { browserId: string }) {
  const exists = useBrowserStore((state) => Boolean(state.browsersById[browserId]));
  const { t } = useTranslation();
  if (!exists) {
    return (
      <View style={styles.messageContainer}>
        <Text style={styles.message}>{t("workspace.browser.devTools.browserClosed")}</Text>
      </View>
    );
  }
  return <AttachedDevTools key={browserId} browserId={browserId} />;
}

function AttachedDevTools({ browserId }: { browserId: string }) {
  const { t } = useTranslation();
  const { focusPane } = usePaneFocus();
  const onFocus = useStableEvent(focusPane);
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(reduceDevTools, { status: "loading", revision: 0 });
  const retry = useCallback(() => dispatch("retry"), []);

  useEffect(() => {
    const desktop = getDesktopHost();
    const bridge = desktop?.browser;
    const host = hostRef.current;
    if (
      !desktop ||
      !host ||
      !bridge?.createDevTools ||
      !bridge.updateDevTools ||
      !bridge.destroyDevTools
    ) {
      dispatch("failed");
      return;
    }
    const create = bridge.createDevTools;
    const update = bridge.updateDevTools;
    const destroy = bridge.destroyDevTools;
    const element = host;
    const instanceId = crypto.randomUUID();
    let disposed = false;
    let ready = false;
    let frame = 0;
    let lastBounds = "";
    function failed() {
      if (disposed) return;
      ready = false;
      dispatch("failed");
      void destroy(instanceId);
    }
    function updateGeometry() {
      frame = 0;
      if (!ready || disposed) return;
      const rect = element.getBoundingClientRect();
      // Native child views paint above DOM portals. Hide them while a menu or
      // modal owns input, and when the retained workspace panel has no layout.
      const hidden = rect.width <= 0 || rect.height <= 0 || hasActiveWebOverlay();
      const bounds = hidden
        ? null
        : {
            x: Math.max(0, rect.x),
            y: Math.max(0, rect.y),
            width: rect.width,
            height: rect.height,
          };
      const serialized = JSON.stringify(bounds);
      if (serialized === lastBounds) return;
      lastBounds = serialized;
      void update(instanceId, bounds).catch(failed);
    }
    function scheduleGeometry() {
      if (!frame) frame = requestAnimationFrame(updateGeometry);
    }
    const resize = new ResizeObserver(scheduleGeometry);
    const mutations = new MutationObserver(scheduleGeometry);
    let ancestor: HTMLElement | null = host;
    while (ancestor) {
      resize.observe(ancestor);
      mutations.observe(ancestor, {
        attributes: true,
        attributeFilter: ["style", "class", "hidden"],
      });
      ancestor = ancestor.parentElement;
    }
    mutations.observe(getOverlayRoot(), { childList: true, subtree: true, attributes: true });
    window.addEventListener("resize", scheduleGeometry);
    window.addEventListener("scroll", scheduleGeometry, true);
    const disconnected = desktop.events?.on?.(
      "browser-devtools-disconnected",
      (payload: unknown) => {
        if (matchesInstance(payload, instanceId)) failed();
      },
    );
    const focused = desktop.events?.on?.("browser-devtools-focused", (payload: unknown) => {
      if (matchesInstance(payload, instanceId)) onFocus();
    });
    const registered = desktop.events?.on?.("browser-registered", (payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "browserId" in payload &&
        payload.browserId === browserId
      )
        dispatch("retry");
    });
    void create(browserId, instanceId)
      .then(() => {
        if (disposed) return;
        ready = true;
        dispatch("ready");
        scheduleGeometry();
        return undefined;
      })
      .catch(failed);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", scheduleGeometry);
      window.removeEventListener("scroll", scheduleGeometry, true);
      for (const subscription of [disconnected, focused, registered]) {
        void Promise.resolve(subscription).then((dispose) => dispose?.());
      }
      void destroy(instanceId);
    };
  }, [browserId, state.revision, onFocus]);

  return (
    <View style={styles.container}>
      <div
        ref={hostRef}
        style={hostStyle}
        data-browser-devtools={browserId}
        data-devtools-status={state.status}
      />
      {state.status !== "ready" && (
        <View style={styles.messageContainer}>
          <Text style={styles.message}>
            {state.status === "loading"
              ? t("workspace.browser.devTools.loading")
              : t("workspace.browser.devTools.failed")}
          </Text>
          {state.status === "failed" && (
            <Button size="sm" variant="outline" onPress={retry}>
              {t("workspace.browser.devTools.retry")}
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

function matchesInstance(payload: unknown, instanceId: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "instanceId" in payload &&
    payload.instanceId === instanceId
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  messageContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));
