import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { darkTheme, lightTheme } from "@/styles/theme";
import { useSkinLibrary } from "./use-library";

export function SkinBackground({ disabled = false }: { disabled?: boolean }) {
  const { data } = useSkinLibrary();
  const active = disabled ? null : data?.active;
  const blob = active?.image;
  const [source, setSource] = useState<{ image: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) {
      setSource(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setSource({ image: blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  const enabled = Boolean(active);
  useEffect(() => {
    if (!enabled) return;
    const previous = document.body.style.isolation;
    document.body.style.isolation = "isolate";
    return () => {
      document.body.style.isolation = previous;
    };
  }, [enabled]);
  const base = active?.appearance === "light" ? lightTheme : darkTheme;
  const background = active?.colors?.background ?? base.colors.surface0;
  const layerStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: -1,
      pointerEvents: "none",
      backgroundColor: background,
    }),
    [background],
  );
  const imageStyle = useMemo<CSSProperties>(
    () => ({
      width: "100%",
      height: "100%",
      objectFit: "cover",
      objectPosition: `${(active?.focusX ?? 0.5) * 100}% ${(active?.focusY ?? 0.5) * 100}%`,
      opacity: data?.strength,
    }),
    [active?.focusX, active?.focusY, data?.strength],
  );
  if (!active || !source || source.image !== active.image) return null;
  return createPortal(
    <div data-testid="skin-background" aria-hidden="true" style={layerStyle}>
      <img src={source.url} alt="" style={imageStyle} />
    </div>,
    document.body,
  );
}
