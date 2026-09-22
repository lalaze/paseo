import type { ReactNode, CSSProperties } from "react";

const style: CSSProperties = { flex: 1, minWidth: 0 };

export function EntryDragSource({ children }: { children: ReactNode }) {
  return (
    <div draggable style={style}>
      {children}
    </div>
  );
}
