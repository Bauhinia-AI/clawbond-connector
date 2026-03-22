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
import {
  buildClawBondDoctorReport,
  runClawBondSetup
} from "./clawbond-onboarding.ts";
import { CredentialStore } from "./credential-store.ts";

export function registerClawBondCommands(api: OpenClawPluginApi) {
  for (const command of createClawBondCommands(api)) {
    api.registerCommand(command);
  }
}

export function createClawBondCommands(
  api: Pick<OpenClawPluginApi, "config"> & { runtime?: OpenClawPluginApi["runtime"] }
): OpenClawPluginCommandDefinition[] {
  return [
    {
      name: "clawbond",
      description: "Show ClawBond help, or run setup|doctor|status|inbox|activity from one entrypoint.",
      acceptsArgs: true,
      async handler(ctx) {
        const parsed = parseClawBondRootArgs(ctx.args);
        const liveConfig = loadCommandConfig(api);
        if (!parsed.subcommand || parsed.subcommand === "help") {
          return {
            text: formatClawBondCommandHelp()
          };
        }

        if (parsed.subcommand === "status") {
          const snapshot = getClawBondAccountStatusSnapshot(liveConfig, parsed.accountId);
          const settings = snapshot
            ? new CredentialStore(snapshot.stateRoot).loadUserSettingsSync(snapshot.accountId)
            : null;

          return {
            text: formatStatusSnapshotForCommand(snapshot, settings)
          };
        }

        if (parsed.subcommand === "inbox") {
          const digest = await loadClawBondInboxDigest(liveConfig, parsed.accountId);
          return {
            text: formatInboxDigestForCommand(digest)
          };
        }

        if (parsed.subcommand === "activity") {
          const snapshot = loadClawBondActivitySnapshot(liveConfig, parsed.accountId);
          return {
            text: formatActivitySnapshotForCommand(snapshot)
          };
        }

        if (parsed.subcommand === "setup") {
          return {
            text: await runClawBondSetup({
              cfg: liveConfig,
              runtime: api.runtime,
              agentNameArg: parsed.remainder
            })
          };
        }

        if (parsed.subcommand === "doctor") {
          return {
            text: buildClawBondDoctorReport(liveConfig, parsed.accountId)
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
        const liveConfig = loadCommandConfig(api);
        const accountId = normalizeCommandArg(ctx.args);
        const snapshot = getClawBondAccountStatusSnapshot(liveConfig, accountId);
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
        const liveConfig = loadCommandConfig(api);
        const accountId = normalizeCommandArg(ctx.args);
        const digest = await loadClawBondInboxDigest(liveConfig, accountId);
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
        const liveConfig = loadCommandConfig(api);
        const accountId = normalizeCommandArg(ctx.args);
        const snapshot = loadClawBondActivitySnapshot(liveConfig, accountId);
        return {
          text: formatActivitySnapshotForCommand(snapshot)
        };
      }
    },
    {
      name: "clawbond-setup",
      description: "Write a minimal ClawBond config and onboarding defaults into openclaw.json.",
      acceptsArgs: true,
      async handler(ctx) {
        const liveConfig = loadCommandConfig(api);
        return {
          text: await runClawBondSetup({
            cfg: liveConfig,
            runtime: api.runtime,
            agentNameArg: normalizeCommandArg(ctx.args)
          })
        };
      }
    },
    {
      name: "clawbond-doctor",
      description: "Check ClawBond install, binding, and readiness, then suggest the next step.",
      acceptsArgs: true,
      async handler(ctx) {
        const liveConfig = loadCommandConfig(api);
        return {
          text: buildClawBondDoctorReport(liveConfig, normalizeCommandArg(ctx.args))
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

function loadCommandConfig(
  api: Pick<OpenClawPluginApi, "config"> & { runtime?: OpenClawPluginApi["runtime"] }
) {
  return api.runtime?.config?.loadConfig?.() ?? api.config;
}

type ClawBondRootSubcommand = "help" | "setup" | "doctor" | "status" | "inbox" | "activity";

function parseClawBondRootArgs(
  value: string | undefined
): {
  subcommand: ClawBondRootSubcommand | null | string;
  accountId: string | null;
  remainder: string | null;
} {
  if (!value?.trim()) {
    return { subcommand: null, accountId: null, remainder: null };
  }

  const [rawSubcommand, ...rest] = value.trim().split(/\s+/);
  const subcommand = rawSubcommand?.trim().toLowerCase() ?? null;
  const remainder = rest.length > 0 ? rest.join(" ").trim() : null;
  return {
    subcommand,
    accountId: remainder || null,
    remainder: remainder || null
  };
}

function formatClawBondCommandHelp(): string {
  return [
    "ClawBond commands / 可用命令",
    "- `/clawbond` - show this help / 查看帮助",
    "- `/clawbond setup [agentName]` - write the recommended config automatically / 自动写入推荐配置",
    "- `/clawbond doctor [accountId]` - inspect install, binding, and next step / 检查安装、绑定和下一步",
    "- `/clawbond status [accountId]` - account, binding, local settings / 查看账号、绑定、插件设置",
    "- `/clawbond inbox [accountId]` - unread DMs, notifications, requests / 查看未读私信、通知、请求",
    "- `/clawbond activity [accountId]` - recent realtime/plugin activity / 查看近期实时活动",
    "- direct aliases / 直接别名: `/clawbond-setup`, `/clawbond-doctor`, `/clawbond-status`, `/clawbond-inbox`, `/clawbond-activity`",
    "- discovery tip / 发现入口: OpenClaw `/commands` should also list plugin commands"
  ].join("\n");
}
