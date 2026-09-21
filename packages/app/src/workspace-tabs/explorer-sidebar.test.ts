import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarTarget,
  openExplorerSidebarView,
  resolveExplorerSidebarPresentation,
  toggleExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";
import { projectBrowserDevToolsLayout } from "@/desktop/browser/devtools/layout";

const WORKSPACE_KEY = "server-1:ws-main";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTab: "files",
    explorerTabByCheckout: {},
  });
});

describe("Explorer sidebar", () => {
  it("moves an existing browser inspector into Explorer and preserves its tab", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "a" },
      intent: "reveal",
    });
    const sideId = store.ensureSidePane(WORKSPACE_KEY)!;
    const target = { kind: "browser_devtools", browserId: "a" } as const;
    const tabId = store.openTab({
      intent: "reveal",
      workspaceKey: WORKSPACE_KEY,
      target,
      placement: { mode: "pane", paneId: sideId },
    });
    openExplorerSidebarTarget(WORKSPACE_KEY, target);
    openExplorerSidebarTarget(WORKSPACE_KEY, target);
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const explorer = findPaneById(layout.root, selectExplorerSidebarPaneId(state, WORKSPACE_KEY)!)!;
    expect(explorer.focusedTabId).toBe(tabId);
    expect(explorer.hidden).not.toBe(true);
    expect(
      collectAllTabs(layout.root).filter((tab) => tab.target.kind === "browser_devtools"),
    ).toHaveLength(1);
    expect(findPaneById(layout.root, sideId)?.tabIds ?? []).not.toContain(tabId);
  });

  it("follows browser tabs within Explorer while retaining Files and Changes", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "a" },
      intent: "reveal",
    });
    openExplorerSidebarTarget(WORKSPACE_KEY, { kind: "files" });
    openExplorerSidebarTarget(WORKSPACE_KEY, { kind: "changes_tree" });
    openExplorerSidebarTarget(WORKSPACE_KEY, { kind: "browser_devtools", browserId: "a" });
    openExplorerSidebarTarget(WORKSPACE_KEY, { kind: "browser_devtools", browserId: "b" });
    const state = useWorkspaceLayoutStore.getState();
    const saved = state.layoutByWorkspace[WORKSPACE_KEY];
    const explorerId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY)!;
    const inspectorA = collectAllTabs(saved.root).find(
      (tab) => tab.target.kind === "browser_devtools" && tab.target.browserId === "a",
    )!;
    const projected = projectBrowserDevToolsLayout(saved);
    expect(findPaneById(projected.root, explorerId)?.focusedTabId).toBe(inspectorA.tabId);
    expect(collectAllTabs(projected.root)).toEqual(collectAllTabs(saved.root));

    const mainPane = collectAllPanes(saved.root).find((pane) => pane.id !== explorerId)!;
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "browser", browserId: "c" },
      intent: "reveal",
      placement: { mode: "pane", paneId: mainPane.id },
    });
    const withoutInspector = projectBrowserDevToolsLayout(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY],
    );
    const active = collectAllTabs(withoutInspector.root).find(
      (tab) => tab.tabId === findPaneById(withoutInspector.root, explorerId)?.focusedTabId,
    );
    expect(active?.target.kind).toBe("files");
    expect(findPaneById(withoutInspector.root, explorerId)?.hidden).not.toBe(true);
  });

  it("selects the Explorer shell from layout and split capabilities", () => {
    expect(resolveExplorerSidebarPresentation({ isCompact: true })).toBe("overlay");
    expect(
      resolveExplorerSidebarPresentation({ isCompact: false, supportsPaneSplits: false }),
    ).toBe("dock");
    expect(resolveExplorerSidebarPresentation({ isCompact: false, supportsPaneSplits: true })).toBe(
      "pane",
    );
  });

  it("uses the compact explorer without creating a desktop pane", () => {
    openExplorerSidebarView({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      view: "changes",
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });

  it("creates a dedicated desktop Explorer containing only its requested tree", () => {
    openExplorerSidebarView({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      view: "files",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const paneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    expect(paneId).not.toBeNull();
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target.kind)).toContain("files");
  });

  it("toggles the desktop Explorer independently of ordinary panes", () => {
    const input = {
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
    };
    openExplorerSidebarView({ ...input, view: "files" });
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    const openedState = useWorkspaceLayoutStore.getState();
    const openedLayout = openedState.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = selectExplorerSidebarPaneId(openedState, WORKSPACE_KEY);
    const explorerPane =
      openedLayout && explorerPaneId ? findPaneById(openedLayout.root, explorerPaneId) : null;
    const activeExplorerTarget =
      openedLayout && explorerPane
        ? collectAllTabs(openedLayout.root).find((tab) => tab.tabId === explorerPane.focusedTabId)
            ?.target.kind
        : null;
    expect(activeExplorerTarget).toBe("files");
  });

  it("toggles the compact Explorer without changing its selected view", () => {
    usePanelStore.getState().setExplorerTabForCheckout({ ...CHECKOUT, tab: "files" });
    const input = {
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
    };

    toggleExplorerSidebar(input);

    expect(isExplorerSidebarOpen(input)).toBe(true);
    expect(usePanelStore.getState().explorerTab).toBe("files");
  });
});
