import { Wrench } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { useBrowserStore } from "@/desktop/browser/store";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor } from "@/panels/panel-registry";
import { DevToolsPane } from "./pane";

function DevToolsPanel() {
  const { target } = usePaneContext();
  invariant(target.kind === "browser_devtools", "DevToolsPanel requires a browser_devtools target");
  return <DevToolsPane browserId={target.browserId} />;
}

function useDevToolsDescriptor(target: {
  kind: "browser_devtools";
  browserId: string;
}): PanelDescriptor {
  const { t } = useTranslation();
  const browser = useBrowserStore((state) => state.browsersById[target.browserId]);
  const title = t("workspace.browser.devTools.title");
  const subtitle = browser?.title || browser?.url || "";
  return {
    label: title,
    subtitle,
    tooltip: subtitle ? `${title}: ${subtitle}` : title,
    titleState: "ready",
    icon: Wrench,
    statusBucket: null,
  };
}

export const browserDevToolsPanelRegistration = definePanel("browser_devtools", {
  component: DevToolsPanel,
  useDescriptor: useDevToolsDescriptor,
});
