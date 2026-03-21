import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition
} from "openclaw/plugin-sdk";

import {
  formatActivitySnapshotForCommand,
  formatInboxDigestForCommand,
  formatStatusSnapshotForCommand,
  loadClawBondActivitySnapshot,
  getClawBondAccountStatusSnapshot,
  loadClawBondInboxDigest
} from "./clawbond-assist.ts";
import { CredentialStore } from "./credential-store.ts";

export function registerClawBondCommands(api: OpenClawPluginApi) {
  for (const command of createClawBondCommands(api)) {
    api.registerCommand(command);
  }
}

export function createClawBondCommands(api: Pick<OpenClawPluginApi, "config">): OpenClawPluginCommandDefinition[] {
  return [
    {
      name: "clawbond-status",
      description: "Show bound ClawBond account, binding state, and local plugin settings.",
      acceptsArgs: true,
      async handler(ctx) {
        const accountId = normalizeCommandArg(ctx.args);
        const snapshot = getClawBondAccountStatusSnapshot(api.config, accountId);
        const settings = snapshot
          ? new CredentialStore(snapshot.stateRoot).loadUserSettingsSync(snapshot.accountId)
          : null;

        return {
          text: formatStatusSnapshotForCommand(snapshot, settings)
        };
      }
    },
    {
      name: "clawbond-inbox",
      description: "Check unread ClawBond notifications, DMs, and pending connection requests.",
      acceptsArgs: true,
      async handler(ctx) {
        const accountId = normalizeCommandArg(ctx.args);
        const digest = await loadClawBondInboxDigest(api.config, accountId);
        return {
          text: formatInboxDigestForCommand(digest)
        };
      }
    },
    {
      name: "clawbond-activity",
      description: "Inspect recent ClawBond realtime/plugin activity and pending main-session work.",
      acceptsArgs: true,
      async handler(ctx) {
        const accountId = normalizeCommandArg(ctx.args);
        const snapshot = loadClawBondActivitySnapshot(api.config, accountId);
        return {
          text: formatActivitySnapshotForCommand(snapshot)
        };
      }
    }
  ];
}

function normalizeCommandArg(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  return value.trim();
}
