import os from "node:os";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import { BootstrapClient } from "./bootstrap-client.ts";
import { resolveAccount } from "./config.ts";
import { CredentialStore, resolveStateRoot } from "./credential-store.ts";

const DEFAULT_SERVER_URL = "https://observant-blessing-production-fbe8.up.railway.app";
const DEFAULT_INVITE_WEB_BASE_URL = "https://dev.clawbond.ai/invite";
const DEFAULT_STATE_ROOT = "~/.clawbond";
const DEFAULT_NOTIFICATION_POLL_INTERVAL_MS = 10000;
const DEFAULT_BIND_STATUS_POLL_INTERVAL_MS = 5000;

export type ClawBondSetupPlan = {
  nextConfig: OpenClawConfig;
  changedFields: string[];
  agentName: string;
  serverUrl: string;
  inviteWebBaseUrl: string;
  stateRoot: string;
  visibleMainSessionNotes: boolean;
};

export async function runClawBondSetup(params: {
  cfg: OpenClawConfig;
  runtime?: PluginRuntime;
  agentNameArg?: string | null;
}): Promise<string> {
  const currentConfig = params.runtime?.config?.loadConfig?.() ?? params.cfg;
  const plan = buildClawBondSetupConfig(currentConfig, {
    agentNameArg: params.agentNameArg
  });
  const writeConfigFile = params.runtime?.config?.writeConfigFile;

  if (!writeConfigFile) {
    return [
      "ClawBond setup preview",
      "- config write: unavailable in this runtime",
      `- suggested agent name: ${plan.agentName}`,
      `- server: ${plan.serverUrl}`,
      `- stateRoot: ${plan.stateRoot}`,
      "",
      "This OpenClaw runtime does not expose config writes to plugins yet.",
      "Please add the following block manually under `channels.clawbond`:",
      "",
      JSON.stringify(plan.nextConfig.channels?.clawbond ?? {}, null, 2)
    ].join("\n");
  }

  await writeConfigFile(plan.nextConfig);

  return [
    "ClawBond setup saved.",
    `- agent name: ${plan.agentName}`,
    `- server: ${plan.serverUrl}`,
    `- stateRoot: ${plan.stateRoot}`,
    `- visible realtime notes: ${plan.visibleMainSessionNotes ? "on" : "off"}`,
    `- changed fields: ${plan.changedFields.length > 0 ? plan.changedFields.join(", ") : "(none)"}`,
    "",
    "Next:",
    "1. Wait a moment for OpenClaw config hot reload.",
    "2. Run `/clawbond doctor` or `/clawbond-status`.",
    "3. If binding is still pending, open the invite URL shown there."
  ].join("\n");
}

export function buildClawBondSetupConfig(
  cfg: OpenClawConfig,
  options?: { agentNameArg?: string | null }
): ClawBondSetupPlan {
  const nextChannels = readRecord(cfg.channels);
  const existingChannel = readRecord(nextChannels.clawbond);
  const changedFields: string[] = [];

  const agentName =
    normalizeText(options?.agentNameArg) ||
    normalizeText(existingChannel.agentName) ||
    buildSuggestedAgentName();
  const serverUrl = normalizeText(existingChannel.serverUrl) || DEFAULT_SERVER_URL;
  const inviteWebBaseUrl =
    normalizeText(existingChannel.inviteWebBaseUrl) || DEFAULT_INVITE_WEB_BASE_URL;
  const stateRoot = normalizeText(existingChannel.stateRoot) || DEFAULT_STATE_ROOT;
  const visibleMainSessionNotes =
    typeof existingChannel.visibleMainSessionNotes === "boolean"
      ? existingChannel.visibleMainSessionNotes
      : false;

  const nextChannel: Record<string, unknown> = { ...existingChannel };

  applyDefault(nextChannel, changedFields, "enabled", true);
  applyDefault(nextChannel, changedFields, "serverUrl", serverUrl);
  applyDefault(nextChannel, changedFields, "inviteWebBaseUrl", inviteWebBaseUrl);
  applyDefault(nextChannel, changedFields, "stateRoot", stateRoot);
  applyDefault(nextChannel, changedFields, "agentName", agentName);
  applyDefault(nextChannel, changedFields, "notificationsEnabled", true);
  applyDefault(
    nextChannel,
    changedFields,
    "notificationPollIntervalMs",
    DEFAULT_NOTIFICATION_POLL_INTERVAL_MS
  );
  applyDefault(
    nextChannel,
    changedFields,
    "bindStatusPollIntervalMs",
    DEFAULT_BIND_STATUS_POLL_INTERVAL_MS
  );
  applyDefault(nextChannel, changedFields, "visibleMainSessionNotes", false);

  if (normalizeText(options?.agentNameArg)) {
    nextChannel.agentName = agentName;
    if (!changedFields.includes("agentName")) {
      changedFields.push("agentName");
    }
  }

  const nextConfig: OpenClawConfig = {
    ...cfg,
    channels: {
      ...nextChannels,
      clawbond: nextChannel
    }
  };

  return {
    nextConfig,
    changedFields,
    agentName,
    serverUrl,
    inviteWebBaseUrl,
    stateRoot,
    visibleMainSessionNotes
  };
}

export function buildClawBondDoctorReport(
  cfg: OpenClawConfig,
  accountId?: string | null
): string {
  const account = resolveAccount(cfg, accountId);
  const rawChannel = readRecord(readRecord(cfg.channels).clawbond);
  const stored = new CredentialStore(resolveStateRoot(normalizeText(rawChannel.stateRoot))).loadSync(
    account.accountId
  );
  const installSpec = readPluginInstallSpec(cfg);
  const installTracking = describeInstallTracking(installSpec);

  const lines = [
    `ClawBond doctor (${account.accountId})`,
    "- plugin: loaded",
    `- config block: ${Object.keys(rawChannel).length > 0 ? "present" : "missing"}`,
    `- install tracking: ${installTracking}`,
    `- local credentials: ${stored ? "found" : "missing"}`,
    `- server: ${account.serverUrl || "(not configured)"}`,
    `- agent: ${account.agentName || stored?.credentials.agent_name || "(not set)"}`,
    `- agentId: ${account.agentId || stored?.credentials.agent_id || "(none)"}`,
    `- binding: ${account.bindingStatus}`,
    `- notifications: ${account.notificationsEnabled ? "enabled" : "disabled"}`,
    `- visible realtime notes: ${account.visibleMainSessionNotes ? "on" : "off"}`
  ];

  const inviteUrl = buildInviteUrl(account);
  const nextStep = describeDoctorNextStep({
    rawChannel,
    accountConfigured: Boolean(account.configured),
    bindingStatus: account.bindingStatus,
    inviteUrl
  });

  if (inviteUrl) {
    lines.push(`- invite: ${inviteUrl}`);
  }

  lines.push("", `Next: ${nextStep}`);
  return lines.join("\n");
}

export function buildClawBondWelcomeMessage(cfg: OpenClawConfig): string | null {
  const account = resolveAccount(cfg);
  const rawChannel = readRecord(readRecord(cfg.channels).clawbond);

  if (Object.keys(rawChannel).length === 0 || !account.configured) {
    return [
      "ClawBond is installed. Run `/clawbond setup` to finish setup.",
      "ClawBond 已安装，输入 `/clawbond setup` 完成初始化。"
    ].join(" / ");
  }

  if (account.bindingStatus !== "bound") {
    return [
      "ClawBond setup is ready, but binding is not finished yet. Run `/clawbond doctor`.",
      "ClawBond 已完成基础配置，但还没绑定完成。输入 `/clawbond doctor` 继续。"
    ].join(" / ");
  }

  return null;
}

function buildInviteUrl(account: ReturnType<typeof resolveAccount>): string | null {
  if (!account.bindCode || !account.inviteWebBaseUrl || !account.serverUrl) {
    return null;
  }

  return (
    new BootstrapClient(account.apiBaseUrl || account.serverUrl).buildInviteUrl(
      account.bindCode,
      account.inviteWebBaseUrl
    ) || null
  );
}

function describeDoctorNextStep(params: {
  rawChannel: Record<string, unknown>;
  accountConfigured: boolean;
  bindingStatus: string;
  inviteUrl: string | null;
}): string {
  if (Object.keys(params.rawChannel).length === 0 || !params.accountConfigured) {
    return "run `/clawbond setup`";
  }

  if (params.bindingStatus !== "bound") {
    if (params.inviteUrl) {
      return `finish binding in the browser, then re-check with /clawbond-status (${params.inviteUrl})`;
    }

    return "run `/clawbond-status` and finish binding";
  }

  return "ClawBond is ready; try `/clawbond-inbox` or just keep chatting";
}

function describeInstallTracking(spec: string): string {
  if (!spec) {
    return "(unknown)";
  }

  if (/@beta$/.test(spec)) {
    return `${spec} (tracks beta updates)`;
  }

  if (/@latest$/.test(spec)) {
    return `${spec} (tracks latest updates)`;
  }

  if (/@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(spec)) {
    return `${spec} (pinned exact version)`;
  }

  return spec;
}

function readPluginInstallSpec(cfg: OpenClawConfig): string {
  const plugins = readRecord((cfg as Record<string, unknown>).plugins);
  const installs = readRecord(plugins.installs);
  const install = readRecord(installs["clawbond-connector"]);
  return normalizeText(install.spec);
}

function applyDefault(
  record: Record<string, unknown>,
  changedFields: string[],
  key: string,
  fallback: unknown
) {
  const current = record[key];
  const missing =
    current === undefined ||
    current === null ||
    (typeof current === "string" && current.trim().length === 0);

  if (!missing) {
    return;
  }

  record[key] = fallback;
  changedFields.push(key);
}

function buildSuggestedAgentName(): string {
  const hostname = sanitizeAgentNameSegment(os.hostname());
  let username = "";
  try {
    username = sanitizeAgentNameSegment(os.userInfo().username);
  } catch {
    username = "";
  }
  if (hostname && username) {
    return `${username}-${hostname}-openclaw`;
  }
  if (hostname) {
    return `${hostname}-openclaw`;
  }
  if (username) {
    return `${username}-openclaw`;
  }
  return "openclaw-agent";
}

function sanitizeAgentNameSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
