import { describe, expect, it } from "vitest";
import { parseBingWallpaper, bingImageUrl } from "./bing.js";

const image = {
  fullstartdate: "202609231600",
  url: "/th?id=OHR.ElGolfo_ZH-CN8329995759_1920x1080.jpg&pid=hp",
  title: "火山灰与浪花相遇",
  copyright: "黑色熔岩海滩 (© Westend61/Adobe Stock)",
  copyrightlink: "https://www.bing.com/search?q=El+Golfo",
};

describe("Bing wallpaper archive", () => {
  it("keeps the current image, date and attribution from Bing's archive", () => {
    expect(parseBingWallpaper({ images: [image] })).toEqual({
      date: "202609231600",
      url: "https://www.bing.com/th?id=OHR.ElGolfo_ZH-CN8329995759_1920x1080.jpg&pid=hp",
      title: "火山灰与浪花相遇",
      copyright: "黑色熔岩海滩 (© Westend61/Adobe Stock)",
      copyrightUrl: "https://www.bing.com/search?q=El+Golfo",
    });
  });

  it("rejects empty and malformed responses instead of replacing a good wallpaper", () => {
    expect(() => parseBingWallpaper({ images: [] })).toThrow();
    expect(() =>
      parseBingWallpaper({ images: [{ ...image, fullstartdate: "invalid" }] }),
    ).toThrow();
    expect(() =>
      parseBingWallpaper({ images: [{ ...image, url: "https://example.com/image.jpg" }] }),
    ).toThrow();
    expect(() =>
      parseBingWallpaper({ images: [{ ...image, copyrightlink: "javascript:alert(1)" }] }),
    ).toThrow();
  });
});

describe("Bing image download boundary", () => {
  it("reconstructs only the official image endpoint and drops unrelated parameters", () => {
    expect(
      bingImageUrl(
        "https://www.bing.com/th?id=OHR.Coast_EN-US123_1920x1080.jpg&redirect=https://example.com",
      ),
    ).toBe("https://www.bing.com/th?id=OHR.Coast_EN-US123_1920x1080.jpg");
  });
  it.each([
    "http://www.bing.com/th?id=OHR.Coast_1920x1080.jpg",
    "https://www.bing.com:8080/th?id=OHR.Coast_1920x1080.jpg",
    "https://www.bing.com.example.com/th?id=OHR.Coast_1920x1080.jpg",
    "https://user@www.bing.com/th?id=OHR.Coast_1920x1080.jpg",
    "https://www.bing.com/redirect?id=OHR.Coast_1920x1080.jpg",
    "https://www.bing.com/th?id=../../etc/passwd",
  ])("rejects arbitrary destinations: %s", (url) => expect(() => bingImageUrl(url)).toThrow());
});
