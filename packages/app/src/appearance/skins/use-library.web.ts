import { useReplicaQuery } from "@/data/query";
import { readSkinLibrary, selectSkin } from "./storage.web";
import { SKIN_LIBRARY_KEY } from "./model";

export function deactivateSkin(): Promise<void> {
  return selectSkin(null, 0.3);
}

export function useSkinLibrary() {
  return useReplicaQuery({
    queryKey: SKIN_LIBRARY_KEY,
    queryFn: readSkinLibrary,
    pushEvent: "local:image-skins-changed",
  });
}
