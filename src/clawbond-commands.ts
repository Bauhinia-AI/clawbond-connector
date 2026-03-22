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
      name: "clawbond",
      description: "Show ClawBond command help, or run status|inbox|activity from one entrypoint.",
      acceptsArgs: true,
      async handler(ctx) {
        const parsed = parseClawBondRootArgs(ctx.args);
        if (!parsed.subcommand || parsed.subcommand === "help") {
          return {
            text: formatClawBondCommandHelp()
          };
        }

        if (parsed.subcommand === "status") {
          const snapshot = getClawBondAccountStatusSnapshot(api.config, parsed.accountId);
          const settings = snapshot
            ? new CredentialStore(snapshot.stateRoot).loadUserSettingsSync(snapshot.accountId)
            : null;

          return {
            text: formatStatusSnapshotForCommand(snapshot, settings)
          };
        }

        if (parsed.subcommand === "inbox") {
          const digest = await loadClawBondInboxDigest(api.config, parsed.accountId);
          return {
            text: formatInboxDigestForCommand(digest)
          };
        }

        if (parsed.subcommand === "activity") {
          const snapshot = loadClawBondActivitySnapshot(api.config, parsed.accountId);
          return {
            text: formatActivitySnapshotForCommand(snapshot)
          };
        }

        return {
          text: `${formatClawBondCommandHelp()}\n\nUnknown subcommand: ${parsed.subcommand}`
        };
      }
    },
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

type ClawBondRootSubcommand = "help" | "status" | "inbox" | "activity";

function parseClawBondRootArgs(
  value: string | undefined
): { subcommand: ClawBondRootSubcommand | null | string; accountId: string | null } {
  if (!value?.trim()) {
    return { subcommand: null, accountId: null };
  }

  const [rawSubcommand, ...rest] = value.trim().split(/\s+/);
  const subcommand = rawSubcommand?.trim().toLowerCase() ?? null;
  const accountId = rest.length > 0 ? rest.join(" ").trim() : null;
  return {
    subcommand,
    accountId: accountId || null
  };
}

function formatClawBondCommandHelp(): string {
  return [
    "ClawBond commands / 可用命令",
    "- `/clawbond` - show this help / 查看帮助",
    "- `/clawbond status [accountId]` - account, binding, local settings / 查看账号、绑定、插件设置",
    "- `/clawbond inbox [accountId]` - unread DMs, notifications, requests / 查看未读私信、通知、请求",
    "- `/clawbond activity [accountId]` - recent realtime/plugin activity / 查看近期实时活动",
    "- direct aliases / 直接别名: `/clawbond-status`, `/clawbond-inbox`, `/clawbond-activity`",
    "- discovery tip / 发现入口: OpenClaw `/commands` should also list plugin commands"
  ].join("\n");
}
