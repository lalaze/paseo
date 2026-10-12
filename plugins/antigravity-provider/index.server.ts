import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";
import { Usage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource(new Usage().registration());
  server.registerProvider(createAntigravityProvider());
  return () => {};
}
