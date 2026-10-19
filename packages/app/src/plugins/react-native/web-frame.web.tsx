import { useEffect } from "react";
import type { WebFrameProps } from "@getpaseo/plugin/client/react-native";
import { isWeb } from "@/constants/platform";

export function WebFrame({ url, title, onLoad, onError }: WebFrameProps) {
  const parsed = new URL(url);
  const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
  const mixedContent =
    isWeb && window.location.protocol === "https:" && parsed.protocol === "http:";
  let error: string | null = null;
  if (!isHttp) error = "Only HTTP and HTTPS pages can be embedded.";
  if (mixedContent)
    error = "This HTTPS app cannot embed an HTTP page. Configure an HTTPS address for the plugin.";
  if (isWeb && parsed.origin === window.location.origin)
    error = "Embedded pages must use a separate origin from Paseo.";

  useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  if (!isWeb || error) return null;
  return (
    <iframe
      src={url}
      title={title}
      style={frameStyle}
      // The separate-origin check prevents the framed document from accessing Paseo or removing its sandbox.
      // eslint-disable-next-line react/iframe-missing-sandbox
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
    />
  );
}

const frameStyle = { width: "100%", height: "100%", flex: 1, border: 0, minHeight: 0 };
