// Values have already passed skinColorSchema at the package boundary.
export function skinRgb(color: string): number[] {
  if (!color.startsWith("#")) {
    const values = color.slice(color.indexOf("(") + 1, -1).split(",");
    return values.slice(0, 3).map((value) => Math.min(255, Number(value.trim())));
  }
  let hex = color.slice(1);
  if (hex.length < 5) hex = [...hex].map((digit) => digit + digit).join("");
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

export function opaqueSkinColor(color: string, background?: string): string {
  let rgb = skinRgb(color);
  if (background) {
    let alpha = 1;
    if (color.startsWith("#") && color.length === 5)
      alpha = Number.parseInt(color[4] + color[4], 16) / 255;
    if (color.startsWith("#") && color.length === 9)
      alpha = Number.parseInt(color.slice(7), 16) / 255;
    if (color.startsWith("rgba"))
      alpha = Number(color.slice(color.lastIndexOf(",") + 1, -1).trim());
    const base = skinRgb(background);
    rgb = rgb.map((value, index) => Math.round(value * alpha + base[index] * (1 - alpha)));
  }
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function skinAppearance(background: string): "light" | "dark" {
  const [red, green, blue] = skinRgb(background);
  return red * 0.299 + green * 0.587 + blue * 0.114 >= 150 ? "light" : "dark";
}

export function translucentSkinColor(color: string, alpha: number): string {
  return `rgba(${skinRgb(color).join(", ")}, ${alpha})`;
}
