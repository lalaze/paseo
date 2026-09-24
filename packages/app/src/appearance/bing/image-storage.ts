import { Directory, File, Paths } from "expo-file-system";

function imageFile(id: string): File {
  if (id.length > 180 || !/^OHR\.[A-Za-z0-9_-]+_1920x1080\.jpg$/.test(id))
    throw new Error("Invalid wallpaper ID");
  return new File(Paths.document, "bing-wallpapers", id);
}

export async function saveArchiveImage(id: string, base64: string): Promise<void> {
  const directory = new Directory(Paths.document, "bing-wallpapers");
  directory.create({ intermediates: true, idempotent: true });
  imageFile(id).write(base64, { encoding: "base64" });
}
export async function readArchiveImage(id: string): Promise<string | null> {
  const file = imageFile(id);
  return file.exists ? file.uri : null;
}
export async function deleteArchiveImage(id: string): Promise<void> {
  const file = imageFile(id);
  if (file.exists) file.delete();
}
