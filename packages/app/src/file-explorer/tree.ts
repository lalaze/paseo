import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import type { SortOption } from "@/stores/panel-store/state";
import { parentExplorerPath } from "@/utils/explorer-paths";
import { filterVisibleExplorerEntries } from "./visibility";

export const MAX_AUTO_EXPANDED_DIRECTORY_DEPTH = 5;

export interface ExplorerTreeRow {
  entry: ExplorerEntry;
  depth: number;
}

interface FlattenExplorerTreeInput {
  directories: ReadonlyMap<string, ExplorerDirectory>;
  expandedPaths: ReadonlySet<string>;
  sortOption: SortOption;
  showHiddenFiles: boolean;
  manualOrder?: Readonly<Record<string, readonly string[]>>;
}

interface RestoreExpandedDirectoriesInput {
  rootDirectory: ExplorerDirectory;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (path: string) => Promise<ExplorerDirectory | null>;
}

interface ShowHiddenFilesAndRestoreExpandedDirectoriesInput extends Omit<
  RestoreExpandedDirectoriesInput,
  "showHiddenFiles"
> {
  showHiddenFiles: () => void;
}

interface ReconcileRestoredExpandedPathsInput {
  persistedExpandedPaths: ReadonlySet<string>;
  currentExpandedPaths: ReadonlySet<string>;
  restoredExpandedPaths: string[];
}

interface SetExpandedDirectoryPathInput {
  currentExpandedPaths: readonly string[];
  directoryPath: string;
  expanded: boolean;
}

export function flattenExplorerTree({
  directories,
  expandedPaths,
  sortOption,
  showHiddenFiles,
  manualOrder = {},
}: FlattenExplorerTreeInput): ExplorerTreeRow[] {
  const root = directories.get(".");
  if (!root) {
    return [];
  }

  const rows: ExplorerTreeRow[] = [];
  const pending = rowsForDirectory(
    root,
    0,
    sortOption,
    showHiddenFiles,
    manualOrder[root.path],
  ).toReversed();

  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) {
      break;
    }
    rows.push(row);

    const entry = row.entry;
    if (entry.kind !== "directory" || !expandedPaths.has(entry.path)) {
      continue;
    }
    const childDirectory = directories.get(entry.path);
    if (!childDirectory) {
      continue;
    }
    const childRows = rowsForDirectory(
      childDirectory,
      row.depth + 1,
      sortOption,
      showHiddenFiles,
      manualOrder[childDirectory.path],
    );
    for (let index = childRows.length - 1; index >= 0; index -= 1) {
      pending.push(childRows[index]);
    }
  }

  return rows;
}

export async function restoreExpandedDirectories({
  rootDirectory,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
}: RestoreExpandedDirectoriesInput): Promise<string[]> {
  const restoredPaths = ["."];
  const restoredPathSet = new Set(restoredPaths);
  let parentDirectories = [rootDirectory];

  for (let depth = 1; depth <= MAX_AUTO_EXPANDED_DIRECTORY_DEPTH; depth += 1) {
    const pathsToRequest: string[] = [];
    for (const directory of parentDirectories) {
      const entries = filterVisibleExplorerEntries(directory.entries, showHiddenFiles);
      for (const entry of entries) {
        const isPersistedExpandedDirectory =
          entry.kind === "directory" && persistedExpandedPaths.has(entry.path);
        if (isPersistedExpandedDirectory && !restoredPathSet.has(entry.path)) {
          pathsToRequest.push(entry.path);
          restoredPathSet.add(entry.path);
        }
      }
    }
    if (pathsToRequest.length === 0) {
      break;
    }

    const requestedDirectories = await Promise.all(
      pathsToRequest.map((path) => requestDirectoryListing(path)),
    );
    parentDirectories = [];
    for (const directory of requestedDirectories) {
      if (!directory) {
        continue;
      }
      restoredPaths.push(directory.path);
      parentDirectories.push(directory);
    }
  }

  return restoredPaths;
}

export function showHiddenFilesAndRestoreExpandedDirectories({
  rootDirectory,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
}: ShowHiddenFilesAndRestoreExpandedDirectoriesInput): Promise<string[]> {
  showHiddenFiles();
  return restoreExpandedDirectories({
    rootDirectory,
    persistedExpandedPaths,
    showHiddenFiles: true,
    requestDirectoryListing,
  });
}

export function reconcileRestoredExpandedPaths({
  persistedExpandedPaths,
  currentExpandedPaths,
  restoredExpandedPaths,
}: ReconcileRestoredExpandedPathsInput): string[] {
  const reconciledPaths = new Set(restoredExpandedPaths);

  for (const path of persistedExpandedPaths) {
    if (!currentExpandedPaths.has(path)) {
      reconciledPaths.delete(path);
    }
  }
  for (const path of currentExpandedPaths) {
    if (!persistedExpandedPaths.has(path)) {
      reconciledPaths.add(path);
    }
  }

  return Array.from(reconciledPaths);
}

export function setExpandedDirectoryPath({
  currentExpandedPaths,
  directoryPath,
  expanded,
}: SetExpandedDirectoryPathInput): string[] {
  const nextPaths = new Set(currentExpandedPaths);
  if (expanded) {
    nextPaths.add(directoryPath);
  } else {
    nextPaths.delete(directoryPath);
  }
  return Array.from(nextPaths);
}

function rowsForDirectory(
  directory: ExplorerDirectory,
  depth: number,
  sortOption: SortOption,
  showHiddenFiles: boolean,
  manualOrder: readonly string[] = [],
): ExplorerTreeRow[] {
  const visibleEntries = filterVisibleExplorerEntries(directory.entries, showHiddenFiles);
  const sortedEntries = sortExplorerEntries(visibleEntries, sortOption, manualOrder);
  return sortedEntries.map((entry) => ({ entry, depth }));
}

export function sortExplorerEntries(
  entries: ExplorerEntry[],
  sortOption: SortOption,
  manualOrder: readonly string[] = [],
): ExplorerEntry[] {
  const sorted = [...entries];
  const positions = new Map(manualOrder.map((path, index) => [path, index]));
  sorted.sort((a, b) => {
    if (sortOption === "manual") {
      const positionA = positions.get(a.path) ?? Infinity;
      const positionB = positions.get(b.path) ?? Infinity;
      if (positionA !== positionB) return positionA - positionB;
    }
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    switch (sortOption) {
      case "manual":
      case "name":
        return a.name.localeCompare(b.name);
      case "modified":
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      case "size":
        return b.size - a.size;
    }
  });
  return sorted;
}

export interface ExplorerReorder {
  source: string;
  target: string;
  position: "before" | "after";
}

export function reorderExplorerEntries(
  paths: readonly string[],
  { source, target, position }: ExplorerReorder,
): string[] | null {
  const sameDirectory = parentExplorerPath(source) === parentExplorerPath(target);
  if (!sameDirectory || source === target || !paths.includes(source) || !paths.includes(target))
    return null;
  const reordered = paths.filter((path) => path !== source);
  const targetIndex = reordered.indexOf(target);
  reordered.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
  return reordered;
}
