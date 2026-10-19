import { useEffect, useRef } from "react";
import type { WebFrameProps } from "@getpaseo/plugin/client/react-native";
import { isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";

export function WebFrame({ url, title, onLoad, onError }: WebFrameProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isWeb || !container.current) return;
    const browser = getDesktopHost()?.browser;
    const partition = browser?.profilePartition;
    const parsed = new URL(url);
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!partition || !isHttp) {
      onError?.("The desktop browser is unavailable or the page is not an HTTP(S) address.");
      return;
    }
    // The desktop's will-attach-webview handler enforces sandboxing, disables Node and owns the preload.
    const guest = document.createElement("webview");
    guest.setAttribute("partition", partition);
    guest.setAttribute("allowpopups", "true");
    guest.setAttribute("src", url);
    guest.style.width = "100%";
    guest.style.height = "100%";
    function loaded() {
      onLoad?.();
    }
    function failed(event: Event) {
      // Chromium reports a cancelled redirect/navigation as ERR_ABORTED, not a page failure.
      if ("errorCode" in event && event.errorCode === -3) return;
      if ("isMainFrame" in event && event.isMainFrame === false) return;
      onError?.("Unable to load the embedded page. Check the host connection and try again.");
    }
    guest.addEventListener("did-finish-load", loaded);
    guest.addEventListener("did-fail-load", failed);
    container.current.appendChild(guest);
    return () => {
      guest.removeEventListener("did-finish-load", loaded);
      guest.removeEventListener("did-fail-load", failed);
      guest.remove();
    };
  }, [url, onLoad, onError]);
  return <div ref={container} aria-label={title} style={containerStyle} />;
}

const containerStyle = { flex: 1, minHeight: 0, width: "100%", height: "100%" };
