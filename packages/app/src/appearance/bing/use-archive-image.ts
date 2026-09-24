import { useFetchQuery } from "@/data/query";
import { readArchiveImage } from "./image-storage";

export function useArchiveImage(id: string | null) {
  return useFetchQuery({
    queryKey: ["bing-wallpaper-image", id],
    dataShape: "value",
    networkMode: "always",
    immutableWhen: () => true,
    enabled: id !== null,
    queryFn: async () => {
      if (!id) return null;
      const image = await readArchiveImage(id);
      if (!image) throw new Error("Archived wallpaper image is missing");
      return image;
    },
  });
}
