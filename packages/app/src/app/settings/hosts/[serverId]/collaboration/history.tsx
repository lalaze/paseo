import { useMemo } from "react";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import SettingsScreen from "@/screens/settings-screen";

export default function CollaborationHistoryRoute() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const view = useMemo(() => ({ kind: "collaboration-history" as const, serverId }), [serverId]);
  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
