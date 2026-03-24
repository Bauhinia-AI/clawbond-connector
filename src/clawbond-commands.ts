import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext
} from "openclaw/plugin-sdk";

import { ClawBondToolSession } from "./clawbond-api.ts";
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
  runClawBondLocalConfigUpdate,
  runClawBondRegisterBind,
  runClawBondRegisterCreate,
  runClawBondSetup
} from "./clawbond-onboarding.ts";
import { CredentialStore } from "./credential-store.ts";
import type { ClawBondReceiveProfile } from "./types.ts";

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

        if (parsed.subcommand === "benchmark") {
          return {
            text: await runClawBondBenchmarkCommand(liveConfig, parsed.remainder)
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

        if (isReceiveProfileSubcommand(parsed.subcommand)) {
          if (!ctx.isAuthorizedSender) {
            return {
              text: "ClawBond receive mode changes are owner-only in this local runtime."
            };
          }

          return {
            text: await runClawBondLocalConfigUpdate({
              cfg: liveConfig,
              runtime: api.runtime,
              accountId: parsed.accountId,
              receiveProfile: parsed.subcommand
            })
          };
        }

        if (parsed.subcommand === "notifications") {
          if (!ctx.isAuthorizedSender) {
            return {
              text: "ClawBond notification toggles are owner-only in this local runtime."
            };
          }

          const toggle = parseOnOffArgument(parsed.args[0] ?? null);
          if (toggle === null) {
            return {
              text: "Usage: /clawbond notifications on|off [accountId]"
            };
          }

          return {
            text: await runClawBondLocalConfigUpdate({
              cfg: liveConfig,
              runtime: api.runtime,
              accountId: parsed.args[1] ?? null,
              notificationsEnabled: toggle
            })
          };
        }

        if (parsed.subcommand === "notes") {
          if (!ctx.isAuthorizedSender) {
            return {
              text: "ClawBond visible note toggles are owner-only in this local runtime."
            };
          }

          const toggle = parseOnOffArgument(parsed.args[0] ?? null);
          if (toggle === null) {
            return {
              text: "Usage: /clawbond notes on|off [accountId]"
            };
          }

          return {
            text: await runClawBondLocalConfigUpdate({
              cfg: liveConfig,
              runtime: api.runtime,
              accountId: parsed.args[1] ?? null,
              visibleMainSessionNotes: toggle
            })
          };
        }

        if (parsed.subcommand === "ws") {
          return {
            text: await runClawBondServerWsCommand(liveConfig, ctx, parsed.args)
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
        const serverWsStatus = snapshot
          ? await loadClawBondServerWsStatus(liveConfig, accountId)
          : null;

        return {
          text: formatStatusSnapshotForCommand(snapshot, settings, serverWsStatus)
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
      name: "clawbond-benchmark",
      description: "Inspect ClawBond benchmark state: latest result, a specific run, or its cases.",
      acceptsArgs: true,
      async handler(ctx) {
        const liveConfig = loadCommandConfig(api);
        return {
          text: await runClawBondBenchmarkCommand(liveConfig, normalizeCommandArg(ctx.args))
        };
      }
    },
    {
      name: "clawbond-setup",
      description: "Write a minimal local ClawBond config into openclaw.json.",
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
      name: "clawbond-register",
      description: "Explicitly register a ClawBond agent after local setup. Pass the desired agent name.",
      acceptsArgs: true,
      async handler(ctx) {
        const liveConfig = loadCommandConfig(api);
        return {
          text: await runClawBondRegisterCreate({
            cfg: liveConfig,
            runtime: api.runtime,
            agentNameArg: normalizeCommandArg(ctx.args)
          })
        };
      }
    },
    {
      name: "clawbond-bind",
      description: "Re-check ClawBond browser binding and refresh local credentials if binding is complete.",
      acceptsArgs: true,
      async handler(ctx) {
        const liveConfig = loadCommandConfig(api);
        return {
          text: await runClawBondRegisterBind({
            cfg: liveConfig,
            runtime: api.runtime,
            accountId: normalizeCommandArg(ctx.args)
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
        const accountId = normalizeCommandArg(ctx.args);
        const serverWsStatus = await loadClawBondServerWsStatus(liveConfig, accountId);
        return {
          text: buildClawBondDoctorReport(liveConfig, accountId, serverWsStatus)
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
  | "activity"
  | "benchmark"
  | "notifications"
  | "notes"
  | "ws"
  | ClawBondReceiveProfile;

function parseClawBondRootArgs(
  value: string | undefined
): {
  subcommand: ClawBondRootSubcommand | null | string;
  accountId: string | null;
  args: string[];
  remainder: string | null;
} {
  if (!value?.trim()) {
    return { subcommand: null, accountId: null, args: [], remainder: null };
  }

  const [rawSubcommand, ...rest] = value.trim().split(/\s+/);
  const subcommand = rawSubcommand?.trim().toLowerCase() ?? null;
  const remainder = rest.length > 0 ? rest.join(" ").trim() : null;
  return {
    subcommand,
    args: rest,
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
    "- `/clawbond focus|balanced|realtime|aggressive [accountId]` - switch local receive mode / 切换本地接收模式",
    "- `/clawbond notifications on|off [accountId]` - toggle local notification ingest / 开关本地通知接收",
    "- `/clawbond notes on|off [accountId]` - toggle visible [ClawBond] notes / 开关主会话里的可见提示",
    "- `/clawbond ws on|off [accountId]` - toggle server-side realtime push gate / 开关服务端实时推送闸门",
    "- `/clawbond doctor [accountId]` - inspect install, binding, and next step / 检查安装、绑定和下一步",
    "- `/clawbond status [accountId]` - read-only account, binding, local settings / 查看账号、绑定、插件设置（只读）",
    "- `/clawbond inbox [accountId]` - unread DMs, notifications, requests / 查看未读私信、通知、请求",
    "- `/clawbond activity [accountId]` - recent realtime/plugin activity / 查看近期实时活动",
    "- `/clawbond benchmark [latest|latest_user|run <runId>|cases <runId>]` - inspect benchmark state / 查看 benchmark 状态",
    "- receive mode quick picks / 接收模式速记:",
    "  `focus` = quieter, `balanced` = default, `realtime` = faster, `aggressive` = everything immediate",
    "- realtime note / 实时说明:",
    "  local receive mode routes events after arrival; `server_ws` controls whether some owner-side events are pushed from the server in realtime at all",
    "- direct aliases / 直接别名: `/clawbond-setup`, `/clawbond-register`, `/clawbond-bind`, `/clawbond-doctor`, `/clawbond-status`, `/clawbond-inbox`, `/clawbond-activity`, `/clawbond-benchmark`",
    "- natural-language tip / 自然语言提示: 你也可以直接对 agent 说“开始接入 ClawBond”或“用这个名字注册 ClawBond”"
  ].join("\n");
}

function isReceiveProfileSubcommand(value: string | null): value is ClawBondReceiveProfile {
  return (
    value === "focus" ||
    value === "balanced" ||
    value === "realtime" ||
    value === "aggressive"
  );
}

function parseOnOffArgument(value: string | null): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "enable" || normalized === "enabled") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "disable" || normalized === "disabled") {
    return false;
  }
  return null;
}

async function runClawBondServerWsCommand(
  cfg: { channels?: Record<string, unknown> },
  ctx: PluginCommandContext,
  args: string[]
): Promise<string> {
  if (!ctx.isAuthorizedSender) {
    return "ClawBond server WebSocket toggles are owner-only in this local runtime.";
  }

  const toggle = parseOnOffArgument(args[0] ?? null);
  if (toggle === null) {
    return "Usage: /clawbond ws on|off [accountId]";
  }

  const session = new ClawBondToolSession(cfg as never, args[1] ?? null);
  const result = await session.withAgentToken("clawbond_command:server_ws", (token) =>
    session.server.toggleWs(token, toggle)
  );
  return [
    `ClawBond server WebSocket ${toggle ? "enabled" : "disabled"} for ${session.account.agentName}.`,
    "- this changes the server-side realtime push gate, not the local receive profile",
    `- server result: ${JSON.stringify(result.data)}`
  ].join("\n");
}

type ClawBondBenchmarkCommandAction = "latest" | "latest_user" | "run" | "cases";

function parseBenchmarkCommandArgs(value: string | null): {
  action: ClawBondBenchmarkCommandAction;
  runId: string | null;
  accountId: string | null;
} {
  if (!value?.trim()) {
    return { action: "latest", runId: null, accountId: null };
  }

  const parts = value.trim().split(/\s+/);
  const action = parts[0]?.toLowerCase();
  switch (action) {
    case "latest":
    case "latest_user":
      return {
        action,
        runId: null,
        accountId: parts[1]?.trim() || null
      };
    case "run":
    case "cases":
      return {
        action,
        runId: parts[1]?.trim() || null,
        accountId: parts[2]?.trim() || null
      };
    default:
      return {
        action: "latest",
        runId: null,
        accountId: value.trim()
      };
  }
}

async function runClawBondBenchmarkCommand(
  cfg: { channels?: Record<string, unknown> },
  args: string | null
): Promise<string> {
  const parsed = parseBenchmarkCommandArgs(args);
  const session = new ClawBondToolSession(cfg as never, parsed.accountId);
  const benchmark = session.requireBenchmark();

  return session.withAgentToken("clawbond_benchmark:command", async (token) => {
    switch (parsed.action) {
      case "latest":
        return formatBenchmarkSummary(
          session.account.accountId,
          "latest",
          (await benchmark.getLatestAgentRun(token)).data
        );
      case "latest_user":
        return formatBenchmarkSummary(
          session.account.accountId,
          "latest_user",
          (await benchmark.getLatestUserRun(token)).data
        );
      case "run":
        return formatBenchmarkSummary(
          session.account.accountId,
          "run",
          (await benchmark.getRun(token, requireBenchmarkRunId(parsed))).data
        );
      case "cases":
        return formatBenchmarkCases(
          session.account.accountId,
          requireBenchmarkRunId(parsed),
          (await benchmark.listRunCases(token, requireBenchmarkRunId(parsed))).data
        );
    }
  });
}

function requireBenchmarkRunId(parsed: { runId: string | null }): string {
  if (!parsed.runId) {
    throw new Error("runId is required for this benchmark command");
  }

  return parsed.runId;
}

function formatBenchmarkSummary(
  accountId: string,
  action: "latest" | "latest_user" | "run",
  raw: Record<string, unknown> | null
): string {
  if (!raw) {
    return [
      `ClawBond benchmark ${action} (${accountId})`,
      "- status: no benchmark result found yet"
    ].join("\n");
  }

  const runId = readTextField(raw, ["id", "run_id"]);
  const status = readTextField(raw, ["status"]);
  const algorithmVersion = readTextField(raw, ["algorithm_version", "algorithmVersion"]);
  const scores = readRecordField(raw, ["scores"]);
  const lines = [
    `ClawBond benchmark ${action} (${accountId})`,
    `- runId: ${runId || "(unknown)"}`,
    `- status: ${status || "(unknown)"}`,
    `- algorithmVersion: ${algorithmVersion || "(unknown)"}`
  ];

  if (scores && Object.keys(scores).length > 0) {
    lines.push("- scores:");
    for (const [key, value] of Object.entries(scores)) {
      lines.push(`  - ${key}: ${String(value)}`);
    }
  }

  return lines.join("\n");
}

function formatBenchmarkCases(
  accountId: string,
  runId: string,
  cases: unknown[]
): string {
  const lines = [
    `ClawBond benchmark cases (${accountId})`,
    `- runId: ${runId}`,
    `- case count: ${cases.length}`
  ];

  for (const item of cases.slice(0, 10)) {
    const record = asRecord(item);
    lines.push(
      `- ${readTextField(record, ["id"]) || "(unknown id)"}: ${readTextField(record, ["dimension"]) || "(unknown dimension)"}`
    );
  }

  if (cases.length > 10) {
    lines.push(`- more: ${cases.length - 10} additional case(s) not shown`);
  }

  return lines.join("\n");
}

function readTextField(record: Record<string, unknown>, keys: string[]): string {
  if (!record || typeof record !== "object") {
    return "";
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function readRecordField(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}
