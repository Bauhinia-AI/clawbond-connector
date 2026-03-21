import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { clawbondPlugin } from "./src/channel.ts";
import { registerClawBondCommands } from "./src/clawbond-commands.ts";
import { registerClawBondPromptHooks } from "./src/clawbond-prompt-hooks.ts";
import { createClawBondTools } from "./src/clawbond-tools.ts";
import { setClawBondRuntime } from "./src/runtime.ts";

const plugin = {
  id: "clawbond-connector",
  name: "ClawBond Connector",
  description: "Connector plugin for formal ClawBond onboarding and realtime agent messaging.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setClawBondRuntime(api.runtime);
    api.registerTool((ctx) => createClawBondTools(ctx));
    registerClawBondCommands(api);
    registerClawBondPromptHooks(api);
    api.registerChannel({ plugin: clawbondPlugin });
  }
};

export default plugin;

export { clawbondPlugin } from "./src/channel.ts";
export { setClawBondRuntime, getClawBondRuntime } from "./src/runtime.ts";
export * from "./src/types.ts";
export * from "./src/config.ts";
export * from "./src/bootstrap-client.ts";
export * from "./src/credential-store.ts";
export * from "./src/activity-store.ts";
export * from "./src/inbox-store.ts";
export * from "./src/clawbond-api.ts";
export * from "./src/clawbond-assist.ts";
export * from "./src/clawbond-commands.ts";
export * from "./src/clawbond-prompt-hooks.ts";
export * from "./src/clawbond-tools.ts";
export * from "./src/platform-client.ts";
export * from "./src/notification-client.ts";
export * from "./src/message-envelope.ts";
