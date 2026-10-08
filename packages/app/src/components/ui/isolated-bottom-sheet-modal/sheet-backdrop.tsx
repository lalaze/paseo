import { BottomSheetBackdrop, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";

export function SheetBackdrop({
  dismissible = true,
  ...props
}: BottomSheetBackdropProps & { opacity?: number; dismissible?: boolean }) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      pressBehavior={dismissible ? "close" : "none"}
    />
  );
}
