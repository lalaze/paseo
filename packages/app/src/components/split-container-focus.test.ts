import { describe, expect, it } from "vitest";
import {
  hasMultipleVisiblePanes,
  resolveSplitContainerRoot,
  splitNodeContainsPane,
} from "@/components/split-container-focus";
import type { SplitNode } from "@/stores/workspace-layout-store";
import { projectBrowserDevToolsLayout } from "@/desktop/browser/devtools/layout";
import { collectAllPanes, collectAllTabs, findPaneById } from "@/stores/workspace-layout-actions";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";
import type { WorkspaceTab } from "@/workspace-tabs/model";

const pane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null },
});
const hiddenPane = (id: string): SplitNode => ({
  kind: "pane",
  pane: { id, tabIds: [], focusedTabId: null, hidden: true },
});
const root: SplitNode = {
  kind: "group",
  group: {
    id: "root",
    direction: "horizontal",
    children: [pane("left"), pane("right")],
    sizes: [0.5, 0.5],
  },
};

function browserLayout(activeBrowser: string, inspectorTabs = ["a"]): WorkspaceLayout {
  function tabbedPane(id: string, tabs: WorkspaceTab[], focusedTabId: string): SplitNode {
    const value = { id, tabs, tabIds: tabs.map((tab) => tab.tabId), focusedTabId };
    return { kind: "pane", pane: value };
  }
  return {
    focusedPaneId: "browser",
    root: {
      kind: "group",
      group: {
        id: "browser-split",
        direction: "horizontal",
        sizes: [0.65, 0.35],
        children: [
          tabbedPane(
            "browser",
            ["a", "b"].map((browserId) => ({
              tabId: browserId,
              target: { kind: "browser", browserId },
              createdAt: 1,
            })),
            activeBrowser,
          ),
          tabbedPane(
            "inspector",
            inspectorTabs.map((browserId) => ({
              tabId: `tools-${browserId}`,
              target: { kind: "browser_devtools", browserId },
              createdAt: 1,
            })),
            "tools-a",
          ),
        ],
      },
    },
  };
}

describe("browser inspector visibility", () => {
  it("collapses an inactive browser's inspector without changing saved tabs or widths", () => {
    const saved = browserLayout("b");
    const shown = projectBrowserDevToolsLayout(saved);
    expect(findPaneById(shown.root, "inspector")?.hidden).toBe(true);
    expect(collectAllTabs(shown.root)).toEqual(collectAllTabs(saved.root));
    expect(collectAllPanes(saved.root)[1].hidden).toBeUndefined();
    expect(shown.root.kind === "group" && shown.root.group.sizes).toEqual([0.65, 0.35]);
    const restored = browserLayout("a");
    expect(projectBrowserDevToolsLayout(restored)).toBe(restored);
  });

  it("shows the matching inspector when both browsers have one", () => {
    const saved = browserLayout("b", ["a", "b"]);
    const shown = projectBrowserDevToolsLayout(saved);
    expect(collectAllPanes(shown.root)[1]).toMatchObject({ focusedTabId: "tools-b" });
    expect(collectAllPanes(saved.root)[1].focusedTabId).toBe("tools-a");
  });

  it("keeps unrelated content in a shared inspector pane accessible", () => {
    const saved = browserLayout("b");
    const inspector = collectAllPanes(saved.root)[1];
    // Layout panes also retain their full tab records, beyond their public ids.
    const other: WorkspaceTab = { tabId: "files", target: { kind: "files" }, createdAt: 1 };
    const inspectorWithTabs = {
      ...inspector,
      tabIds: [...inspector.tabIds, other.tabId],
      tabs: [collectAllTabs(saved.root)[2], other],
    };
    if (saved.root.kind !== "group") throw new Error("Expected split fixture");
    saved.root.group.children[1] = { kind: "pane", pane: inspectorWithTabs };
    const shown = projectBrowserDevToolsLayout(saved);
    expect(collectAllPanes(shown.root)[1]).toMatchObject({ focusedTabId: "files" });
    expect(collectAllPanes(shown.root)[1].hidden).not.toBe(true);
  });

  it("keeps an inspector usable when moved into its browser's tab group", () => {
    const saved = browserLayout("a");
    const tabs = collectAllTabs(saved.root);
    const value = {
      id: "browser",
      tabs,
      tabIds: tabs.map((tab) => tab.tabId),
      focusedTabId: "tools-a",
    };
    saved.root = { kind: "pane", pane: value };
    expect(projectBrowserDevToolsLayout(saved)).toBe(saved);
  });

  it("moves presentation focus away from a hidden inspector", () => {
    const saved = browserLayout("b");
    saved.focusedPaneId = "inspector";
    expect(projectBrowserDevToolsLayout(saved).focusedPaneId).toBe("browser");
    expect(saved.focusedPaneId).toBe("inspector");
  });
});

describe("split focus root", () => {
  it("renders only the valid focused pane in focus mode", () => {
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "right", focusModeEnabled: true }),
    ).toEqual({ root: pane("right"), usesFallbackStrip: false });
  });

  it("keeps the full tree and reserves the boundary strip when focus is missing", () => {
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "missing", focusModeEnabled: true }),
    ).toEqual({ root, usesFallbackStrip: true });
  });

  it("keeps normal splits unclaimed", () => {
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "right", focusModeEnabled: false }),
    ).toEqual({ root, usesFallbackStrip: false });
  });

  it("finds the maximized pane without replacing the rendered split tree", () => {
    expect(splitNodeContainsPane(root, "right")).toBe(true);
    expect(splitNodeContainsPane(root, "missing")).toBe(false);
    expect(
      resolveSplitContainerRoot({ root, focusedPaneId: "left", focusModeEnabled: false }),
    ).toEqual({ root, usesFallbackStrip: false });
  });

  it("offers pane maximize only when another pane is visible", () => {
    expect(hasMultipleVisiblePanes(root)).toBe(true);
    expect(hasMultipleVisiblePanes(pane("left"))).toBe(false);
    expect(
      hasMultipleVisiblePanes({
        ...root,
        group: { ...root.group, children: [pane("left"), hiddenPane("right")] },
      }),
    ).toBe(false);
  });
});
