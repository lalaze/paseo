import { z } from "zod";
import type { BingWallpaper } from "@getpaseo/protocol/messages";

const archiveSchema = z.object({
  images: z
    .array(
      z.object({
        fullstartdate: z.string().regex(/^\d{12}$/),
        url: z.string().startsWith("/th?id=OHR."),
        title: z.string(),
        copyright: z.string(),
        copyrightlink: z.url(),
      }),
    )
    .min(1),
});

const cache = new Map<string, { expiresAt: number; wallpaper: BingWallpaper }>();
const pending = new Map<string, Promise<BingWallpaper>>();

export function parseBingWallpaper(value: unknown): BingWallpaper {
  const image = archiveSchema.parse(value).images[0];
  const copyrightUrl = new URL(image.copyrightlink);
  if (copyrightUrl.protocol !== "https:" || copyrightUrl.hostname !== "www.bing.com") {
    throw new Error("Invalid Bing attribution URL");
  }
  return {
    date: image.fullstartdate,
    url: new URL(image.url, "https://www.bing.com").href,
    title: image.title,
    copyright: image.copyright,
    copyrightUrl: copyrightUrl.href,
  };
}

export async function getBingWallpaper(market: string): Promise<BingWallpaper> {
  const cached = cache.get(market);
  if (cached && cached.expiresAt > Date.now()) return cached.wallpaper;
  const existing = pending.get(market);
  if (existing) return existing;
  const request = fetchWallpaper(market);
  pending.set(market, request);
  try {
    return await request;
  } finally {
    pending.delete(market);
  }
}

async function fetchWallpaper(market: string): Promise<BingWallpaper> {
  const url = new URL("https://www.bing.com/HPImageArchive.aspx");
  url.search = new URLSearchParams({ format: "js", idx: "0", n: "1", mkt: market }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Bing wallpaper request failed (${response.status})`);
  const wallpaper = parseBingWallpaper(await response.json());
  cache.set(market, { wallpaper, expiresAt: Date.now() + 60 * 60 * 1000 });
  return wallpaper;
}

// Only the fixed Bing image endpoint is exposed; this must never become a generic URL proxy.
export function bingImageUrl(value: string): string {
  const url = new URL(value);
  const id = url.searchParams.get("id");
  if (
    url.origin !== "https://www.bing.com" ||
    url.username ||
    url.password ||
    url.pathname !== "/th" ||
    !id ||
    !/^OHR\.[A-Za-z0-9_-]+_1920x1080\.jpg$/.test(id) ||
    id.length > 180
  ) {
    throw new Error("Invalid Bing image URL");
  }
  return `https://www.bing.com/th?id=${id}`;
}

export async function getBingWallpaperImage(value: string): Promise<string> {
  const response = await fetch(bingImageUrl(value), {
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error(`Bing image request failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("Bing image exceeds 4 MB");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
  }
  const image = Buffer.concat(chunks);
  if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff)
    throw new Error("Invalid Bing JPEG image");
  return image.toString("base64");
}
