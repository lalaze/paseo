import { getNextActiveIndex } from "./combobox-keyboard";

export type AutocompleteOptionsPosition = "above-input" | "below-input";

export function orderAutocompleteOptions<T>(
  options: readonly T[],
  position: AutocompleteOptionsPosition = "above-input",
): T[] {
  if (position === "below-input") {
    return [...options];
  }
  return [...options].toReversed();
}

export function getAutocompleteFallbackIndex(
  itemCount: number,
  position: AutocompleteOptionsPosition = "above-input",
): number {
  if (itemCount <= 0) {
    return -1;
  }
  return position === "above-input" ? itemCount - 1 : 0;
}

// A different option count means the list was rebuilt (e.g. agent options render before the
// file search returns), so the old index points at an unrelated row. Re-anchor next to the input.
export function resolveAutocompleteSelectedIndex(args: {
  currentIndex: number;
  previousItemCount: number;
  itemCount: number;
  queryChanged: boolean;
  position?: AutocompleteOptionsPosition;
}): number {
  const fallbackIndex = getAutocompleteFallbackIndex(args.itemCount, args.position);
  if (args.queryChanged || args.itemCount !== args.previousItemCount) {
    return fallbackIndex;
  }
  if (args.currentIndex < 0 || args.currentIndex >= args.itemCount) {
    return fallbackIndex;
  }
  return args.currentIndex;
}

export function getAutocompleteNextIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
}): number {
  return getNextActiveIndex(args);
}

export function getAutocompleteScrollOffset(args: {
  currentOffset: number;
  viewportHeight: number;
  itemTop: number;
  itemHeight: number;
}): number {
  if (args.viewportHeight <= 0) {
    return args.currentOffset;
  }

  const itemBottom = args.itemTop + args.itemHeight;
  const viewportTop = args.currentOffset;
  const viewportBottom = args.currentOffset + args.viewportHeight;

  if (args.itemTop < viewportTop) {
    return Math.max(0, args.itemTop);
  }

  if (itemBottom > viewportBottom) {
    return Math.max(0, itemBottom - args.viewportHeight);
  }

  return args.currentOffset;
}
