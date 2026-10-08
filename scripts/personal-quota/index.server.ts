import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { quotaWindows } from "./server/antigravity.js";
import { readLocalQuota } from "./server/antigravity-local.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "antigravity",
    label: "Google Antigravity",
    input: z.object({}).strict(),
    discover: async (scope) => {
      const matchesSession =
        scope.kind === "session" &&
        (scope.provider === "antigravity" || scope.provider === "antigravity-acp");
      return scope.kind === "global" || matchesSession ? [{ key: "local", input: {} }] : [];
    },
    fetch: async () => {
      try {
        const windows = await readLocalQuota(quotaWindows);
        if (windows?.length) return { status: "available", windows };
      } catch {
        // CLI output and local API responses may contain account credentials.
        server.logger.debug("Antigravity local quota unavailable");
      }
      return {
        status: "unavailable",
        problem: {
          kind: "no_quota",
          detail: "Start Antigravity and sign in with agy login to read local quota.",
        },
      };
    },
  });
  return () => {};
}
