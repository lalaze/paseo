import { BottomSheetBackdrop, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";

/**
 * What a backdrop tap does. `dismiss` takes the top modal off the stack and unmounts it; `close`
 * only slides this sheet down, so a sheet that keeps its content through a close can veto it.
 * `none` ignores the tap, for a sheet the owner has locked while work is in flight.
 */
export type SheetBackdropPress = "dismiss" | "close" | "none";

export function SheetBackdrop({
  pressBehavior,
  ...props
}: BottomSheetBackdropProps & { opacity?: number; pressBehavior: SheetBackdropPress }) {
  // Gorhom's native backdrop closes its own sheet, which here is always the top one.
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      pressBehavior={pressBehavior === "none" ? "none" : "close"}
    />
  );
}
