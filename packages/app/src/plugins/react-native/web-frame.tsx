import { useCallback, useMemo } from "react";
import { Linking } from "react-native";
import { WebView } from "react-native-webview";
import type { WebFrameProps } from "@getpaseo/plugin/client/react-native";

export function WebFrame({ url, title, onLoad, onError }: WebFrameProps) {
  const source = useMemo(() => ({ uri: url }), [url]);
  const openExternal = useCallback(
    ({ nativeEvent }: { nativeEvent: { targetUrl: string } }) => {
      const target = new URL(nativeEvent.targetUrl);
      if (target.protocol !== "https:" && target.protocol !== "http:") return;
      void Linking.openURL(target.href).catch(() => onError?.("Unable to open the external page."));
    },
    [onError],
  );
  const reportError = useCallback(
    () => onError?.("Unable to load the embedded page. Check the host connection and try again."),
    [onError],
  );
  return (
    <WebView
      accessibilityLabel={title}
      source={source}
      style={frameStyle}
      originWhitelist={origins}
      onLoad={onLoad}
      onError={reportError}
      onHttpError={reportError}
      onOpenWindow={openExternal}
      allowsBackForwardNavigationGestures
    />
  );
}

const frameStyle = { flex: 1 };
const origins = ["http://*", "https://*"];
