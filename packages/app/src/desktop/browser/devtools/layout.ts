import {
  collectAllPanes,
  collectAllTabs,
  type SplitNode,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";

/** Project inspector visibility without changing saved tabs, splits, or widths. */
export function projectBrowserDevToolsLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const tabs = collectAllTabs(layout.root);
  if (!tabs.some((tab) => tab.target.kind === "browser_devtools")) return layout;
  const tabsById = new Map(tabs.map((tab) => [tab.tabId, tab]));
  const panes = collectAllPanes(layout.root);
  const visibleBrowserIds = new Set<string>();
  const browserPaneIds = new Map<string, string>();
  for (const pane of panes) {
    for (const tabId of pane.tabIds) {
      const target = tabsById.get(tabId)?.target;
      if (target?.kind === "browser") browserPaneIds.set(target.browserId, pane.id);
    }
    if (pane.hidden) continue;
    const active = tabsById.get(pane.focusedTabId ?? pane.tabIds[0])?.target;
    if (active?.kind === "browser") visibleBrowserIds.add(active.browserId);
  }

  function project(node: SplitNode): SplitNode {
    if (node.kind === "group") {
      const children = node.group.children.map(project);
      if (children.every((child, index) => child === node.group.children[index])) return node;
      return { ...node, group: { ...node.group, children } };
    }
    const pane = node.pane;
    if (pane.hidden) return node;
    const activeTabId = pane.focusedTabId ?? pane.tabIds[0];
    const active = tabsById.get(activeTabId)?.target;
    if (active?.kind !== "browser_devtools") return node;
    function canShow(tabId: string): boolean {
      const target = tabsById.get(tabId)?.target;
      if (target?.kind !== "browser_devtools") return true;
      // A user may move the inspector into the same tab group as its browser.
      return (
        browserPaneIds.get(target.browserId) === pane.id || visibleBrowserIds.has(target.browserId)
      );
    }
    if (canShow(activeTabId)) return node;
    const fallback =
      pane.tabIds.find(
        (tabId) => tabsById.get(tabId)?.target.kind === "browser_devtools" && canShow(tabId),
      ) ?? pane.tabIds.find(canShow);
    return {
      ...node,
      pane: fallback ? { ...pane, focusedTabId: fallback } : { ...pane, hidden: true },
    };
  }

  const root = project(layout.root);
  if (root === layout.root) return layout;
  const visiblePanes = collectAllPanes(root).filter((pane) => !pane.hidden);
  const focusedPaneId = visiblePanes.some((pane) => pane.id === layout.focusedPaneId)
    ? layout.focusedPaneId
    : (visiblePanes[0]?.id ?? null);
  return { ...layout, root, focusedPaneId };
}
