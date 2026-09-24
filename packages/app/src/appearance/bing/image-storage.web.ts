async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("paseo-bing-wallpapers", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result);
    request.addEventListener("error", () => reject(request.error));
  });
}

async function accessImage(
  id: string,
  operation: "read" | "save" | "delete",
  base64?: string,
): Promise<string | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(
        "images",
        operation === "read" ? "readonly" : "readwrite",
      );
      const images = transaction.objectStore("images");
      const request = images.get(id);
      if (operation === "save") images.put(`data:image/jpeg;base64,${base64}`, id);
      if (operation === "delete") images.delete(id);
      transaction.oncomplete = () =>
        resolve(typeof request.result === "string" ? request.result : null);
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  } finally {
    database.close();
  }
}

export async function saveArchiveImage(id: string, base64: string): Promise<void> {
  await accessImage(id, "save", base64);
}
export async function deleteArchiveImage(id: string): Promise<void> {
  await accessImage(id, "delete");
}
export function readArchiveImage(id: string): Promise<string | null> {
  return accessImage(id, "read");
}
