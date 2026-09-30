import { describe, expect, it } from "vitest";

import {
  getAutocompleteFallbackIndex,
  getAutocompleteScrollOffset,
  orderAutocompleteOptions,
  resolveAutocompleteSelectedIndex,
} from "./autocomplete-utils";

const OPTIONS = ["alpha", "beta", "gamma"];

describe("orderAutocompleteOptions", () => {
  it("keeps first logical option closest to the input by default", () => {
    expect(orderAutocompleteOptions(OPTIONS)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("keeps normal top-down order when below-input is selected", () => {
    expect(orderAutocompleteOptions(OPTIONS, "below-input")).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("getAutocompleteFallbackIndex", () => {
  it("picks the option nearest the input by default", () => {
    expect(getAutocompleteFallbackIndex(3)).toBe(2);
    expect(getAutocompleteFallbackIndex(0)).toBe(-1);
  });

  it("picks top item when below-input ordering is used", () => {
    expect(getAutocompleteFallbackIndex(3, "below-input")).toBe(0);
  });
});

describe("resolveAutocompleteSelectedIndex", () => {
  it("keeps the current selection when the list is unchanged", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        currentIndex: 1,
        previousItemCount: 3,
        itemCount: 3,
        queryChanged: false,
      }),
    ).toBe(1);
  });

  it("re-anchors next to the input when options arrive late for the same query", () => {
    // Agent options render first; the file search then prepends 50 rows above them.
    expect(
      resolveAutocompleteSelectedIndex({
        currentIndex: 3,
        previousItemCount: 4,
        itemCount: 54,
        queryChanged: false,
      }),
    ).toBe(53);
  });

  it("re-anchors when the query changes", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        currentIndex: 0,
        previousItemCount: 3,
        itemCount: 3,
        queryChanged: true,
      }),
    ).toBe(2);
  });

  it("clears the selection when there are no options", () => {
    expect(
      resolveAutocompleteSelectedIndex({
        currentIndex: 2,
        previousItemCount: 3,
        itemCount: 0,
        queryChanged: false,
      }),
    ).toBe(-1);
  });
});

describe("getAutocompleteScrollOffset", () => {
  it("scrolls up when the active item is above the viewport", () => {
    expect(
      getAutocompleteScrollOffset({
        currentOffset: 120,
        viewportHeight: 80,
        itemTop: 90,
        itemHeight: 20,
      }),
    ).toBe(90);
  });

  it("scrolls down when the active item is below the viewport", () => {
    expect(
      getAutocompleteScrollOffset({
        currentOffset: 0,
        viewportHeight: 100,
        itemTop: 150,
        itemHeight: 24,
      }),
    ).toBe(74);
  });
});
