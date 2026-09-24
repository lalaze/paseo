import { useMutation } from "@tanstack/react-query";
import type { CollaborationCommand } from "@getpaseo/protocol/collaboration/rpc";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

export interface CollaborationCommandInput {
  name: CollaborationCommand;
  input: unknown;
}

export function useCollaboration(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const supportsInlineModels = useHostFeature(serverId, "collaborationInlineModels");
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["collaboration", serverId],
    enabled: !!client,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      return client.collaborationCommand("status");
    },
    refetchInterval: 5000,
  });
  const command = useMutation({
    mutationFn: async ({ name, input }: CollaborationCommandInput) => {
      if (!client) throw new Error("Host disconnected");
      await client.collaborationCommand(name, input);
      await query.refetch();
    },
  });
  return { client, query, command, supportsInlineModels };
}
