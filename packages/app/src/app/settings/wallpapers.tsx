import SettingsScreen from "@/screens/settings-screen";
import type { SettingsView } from "@/navigation/settings-navigation";

const view: SettingsView = { kind: "wallpapers" };

export default function WallpaperLibraryRoute() {
  return <SettingsScreen view={view} />;
}
