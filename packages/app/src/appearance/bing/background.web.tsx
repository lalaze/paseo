import { useEffect, useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { BingBackgroundProps } from "./background";

const imageStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  opacity: 0.3,
};

export function BingBackground({
  url,
  imageAttempt,
  color,
  onError,
  onLoad,
  children,
}: BingBackgroundProps) {
  const enabled = Boolean(url);
  useEffect(() => {
    if (!enabled) return;
    const previous = document.body.style.isolation;
    document.body.style.isolation = "isolate";
    return () => {
      document.body.style.isolation = previous;
    };
  }, [enabled]);
  const style = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: -1,
      pointerEvents: "none",
      backgroundColor: color,
    }),
    [color],
  );
  return (
    <>
      {url
        ? createPortal(
            <div data-testid="bing-wallpaper-background" aria-hidden="true" style={style}>
              <img
                key={`${url}:${imageAttempt}`}
                src={url}
                alt=""
                style={imageStyle}
                onError={onError}
                onLoad={onLoad}
                referrerPolicy="no-referrer"
              />
            </div>,
            document.body,
          )
        : null}
      {children}
    </>
  );
}
