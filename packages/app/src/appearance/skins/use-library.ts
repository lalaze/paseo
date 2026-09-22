import { EMPTY_SKIN_LIBRARY } from "./model";

export function deactivateSkin(): Promise<void> {
  return Promise.resolve();
}

export function useSkinLibrary() {
  return { data: EMPTY_SKIN_LIBRARY, isPending: false, isError: false };
}
