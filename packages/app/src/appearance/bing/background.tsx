import type { ReactNode } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { StyleSheet } from "react-native-unistyles";

export interface BingBackgroundProps {
  url: string | null;
  imageAttempt: number;
  color: string;
  onError: () => void;
  onLoad: () => void;
  children: ReactNode;
}

export function BingBackground({
  url,
  imageAttempt,
  color,
  onError,
  onLoad,
  children,
}: BingBackgroundProps) {
  return (
    <View style={[styles.root, { backgroundColor: color }]}>
      {url ? (
        <Image
          key={`${url}:${imageAttempt}`}
          source={url}
          contentFit="cover"
          cachePolicy="disk"
          style={styles.image}
          onError={onError}
          onLoad={onLoad}
          accessible={false}
          pointerEvents="none"
        />
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  image: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.3 },
});
