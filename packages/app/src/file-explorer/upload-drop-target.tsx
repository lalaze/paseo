import type { ReactNode } from "react";
import { View } from "react-native";
import type { SelectedFile } from "@/attachments/selected-file";

export interface UploadDropTargetProps {
  children: ReactNode;
  disabled: boolean;
  onDrop(files: SelectedFile[], directory: string): void;
  onReject(message: string): void;
}

const containerStyle = { flex: 1, minHeight: 0 };

export function UploadDropTarget({ children }: UploadDropTargetProps) {
  return <View style={containerStyle}>{children}</View>;
}
