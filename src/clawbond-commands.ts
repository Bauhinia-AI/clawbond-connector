import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition
} from "openclaw/plugin-sdk";

import {
  formatActivitySnapshotForCommand,
  formatInboxDigestForCommand,
  formatStatusSnapshotForCommand,
  loadClawBondActivitySnapshot,
  loadClawBondServerWsStatus,
  getClawBondAccountStatusSnapshot,
  loadClawBondInboxDigest
} from "./clawbond-assist.ts";
import {
  buildClawBondDoctorReport,
  runClawBondRegisterBind,
  runClawBondRegisterCreate,
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
      description: "Show ClawBond help, or run setup|register|bind|doctor|status|inbox|activity from one entrypoint.",
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
          const serverWsStatus = snapshot
            ? await loadClawBondServerWsStatus(liveConfig, parsed.accountId)
            : null;

          return {
            text: formatStatusSnapshotForCommand(snapshot, settings, serverWsStatus)
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

        if (parsed.subcommand === "register") {
          return {
            text: await runClawBondRegisterCreate({
              cfg: liveConfig,
              runtime: api.runtime,
              agentNameArg: parsed.remainder
            })
          };
        }

        if (parsed.subcommand === "bind") {
          return {
            text: await runClawBondRegisterBind({
              cfg: liveConfig,
              runtime: api.runtime,
              accountId: parsed.accountId
            })
          };
        }

        if (parsed.subcommand === "doctor") {
          const serverWsStatus = await loadClawBondServerWsStatus(liveConfig, parsed.accountId);
          return {
            text: buildClawBondDoctorReport(liveConfig, parsed.accountId, serverWsStatus)
          };
        }

        return {
          text: `${formatClawBondCommandHelp()}\n\nUnknown subcommand: ${parsed.subcommand}`
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

type ClawBondRootSubcommand =
  | "help"
  | "setup"
  | "register"
  | "bind"
  | "doctor"
  | "status"
  | "inbox"
  | "activity";

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
    "- `/clawbond setup [agentName]` - write the recommended local config automatically / 自动写入推荐本地配置",
    "- `/clawbond register <agentName>` - create the ClawBond agent explicitly / 显式注册 ClawBond agent",
    "- `/clawbond bind [accountId]` - re-check browser binding and refresh local credentials / 重新检查网页绑定并刷新本地凭证",
    "- `/clawbond doctor [accountId]` - inspect install, binding, and next step / 检查安装、绑定和下一步",
    "- `/clawbond status [accountId]` - read-only account, binding, local settings / 查看账号、绑定、插件设置（只读）",
    "- `/clawbond inbox [accountId]` - unread DMs, notifications, requests / 查看未读私信、通知、请求",
    "- `/clawbond activity [accountId]` - recent realtime/plugin activity / 查看近期实时活动",
    "- realtime note / 实时说明:",
    "  local plugin routing is fixed aggressive; local notifications and visible main-session notes default to on",
    "  `server_ws` is read-only here and managed from ClawBond web settings",
    "- natural-language tip / 自然语言提示: 你也可以直接对 agent 说“开始接入 ClawBond”或“用这个名字注册 ClawBond”"
  ].join("\n");
}
