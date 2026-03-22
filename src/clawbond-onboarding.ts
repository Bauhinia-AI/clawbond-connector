import os from "node:os";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import { BootstrapClient } from "./bootstrap-client.ts";
import { resolveAccount, resolveSocialBaseUrl } from "./config.ts";
import {
  CredentialStore,
  getDefaultUserSettings,
  normalizeUserSettings,
  resolveStateRoot
} from "./credential-store.ts";
import type { ClawBondDmDeliveryPreference } from "./types.ts";

const DEFAULT_SERVER_URL = "https://api.clawbond.ai";
const DEFAULT_INVITE_WEB_BASE_URL = "https://dev.clawbond.ai/invite";
const DEFAULT_STATE_ROOT = "~/.clawbond";
const DEFAULT_NOTIFICATION_POLL_INTERVAL_MS = 10000;
const DEFAULT_BIND_STATUS_POLL_INTERVAL_MS = 5000;

export type ClawBondSetupPlan = {
  nextConfig: OpenClawConfig;
  changedFields: string[];
  agentName: string;
  serverUrl: string;
  socialBaseUrl: string;
  inviteWebBaseUrl: string;
  stateRoot: string;
  visibleMainSessionNotes: boolean;
};

export type ClawBondOnboardingSummary = {
  accountId: string;
  phase: "setup_required" | "waiting_for_bind" | "ready";
  configured: boolean;
  configBlockPresent: boolean;
  localCredentialsFound: boolean;
  bindingStatus: string;
  nextStep: string;
  inviteUrl: string | null;
  serverUrl: string;
  socialBaseUrl: string;
  agentName: string;
  agentId: string;
  notificationsEnabled: boolean;
  visibleMainSessionNotes: boolean;
  dmDeliveryPreference: ClawBondDmDeliveryPreference;
  suggestedUserPhrases: string[];
  manualFallbackCommands: string[];
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
      `- social: ${plan.socialBaseUrl}`,
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
    `- social: ${plan.socialBaseUrl}`,
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

export function buildClawBondOnboardingSummary(
  cfg: OpenClawConfig,
  accountId?: string | null
): ClawBondOnboardingSummary {
  const account = resolveAccount(cfg, accountId);
  const rawChannel = readRecord(readRecord(cfg.channels).clawbond);
  const store = new CredentialStore(resolveStateRoot(normalizeText(rawChannel.stateRoot)));
  const stored = store.loadSync(account.accountId);
  const settings = stored
    ? store.loadUserSettingsSync(account.accountId)
    : getDefaultUserSettings();
  const inviteUrl = buildInviteUrl(account);
  const nextStep = describeDoctorNextStep({
    rawChannel,
    accountConfigured: Boolean(account.configured),
    bindingStatus: account.bindingStatus,
    inviteUrl
  });

  return {
    accountId: account.accountId,
    phase:
      Object.keys(rawChannel).length === 0 || !account.configured
        ? "setup_required"
        : account.bindingStatus === "bound"
          ? "ready"
          : "waiting_for_bind",
    configured: Boolean(account.configured),
    configBlockPresent: Object.keys(rawChannel).length > 0,
    localCredentialsFound: Boolean(stored),
    bindingStatus: account.bindingStatus,
    nextStep,
    inviteUrl,
    serverUrl: account.serverUrl,
    socialBaseUrl: account.socialBaseUrl,
    agentName: account.agentName || stored?.credentials.agent_name || "",
    agentId: account.agentId || stored?.credentials.agent_id || "",
    notificationsEnabled: account.notificationsEnabled,
    visibleMainSessionNotes: account.visibleMainSessionNotes,
    dmDeliveryPreference: settings.dm_delivery_preference,
    suggestedUserPhrases: buildSuggestedUserPhrases(
      Object.keys(rawChannel).length === 0 || !account.configured,
      account.bindingStatus
    ),
    manualFallbackCommands: ["/clawbond setup", "/clawbond doctor", "/clawbond status"]
  };
}

export async function runClawBondLocalConfigUpdate(params: {
  cfg: OpenClawConfig;
  runtime?: PluginRuntime;
  accountId?: string | null;
  agentNameArg?: string | null;
  notificationsEnabled?: boolean;
  visibleMainSessionNotes?: boolean;
  dmDeliveryPreference?: ClawBondDmDeliveryPreference | null;
}): Promise<string> {
  const currentConfig = params.runtime?.config?.loadConfig?.() ?? params.cfg;
  const setupPlan = buildClawBondSetupConfig(currentConfig, {
    agentNameArg: params.agentNameArg
  });
  const nextConfig: OpenClawConfig = {
    ...setupPlan.nextConfig,
    channels: {
      ...readRecord(setupPlan.nextConfig.channels),
      clawbond: {
        ...readRecord(readRecord(setupPlan.nextConfig.channels).clawbond)
      }
    }
  };
  const nextChannel = readRecord(readRecord(nextConfig.channels).clawbond);
  const changedFields: string[] = [];

  if (typeof params.notificationsEnabled === "boolean") {
    nextChannel.notificationsEnabled = params.notificationsEnabled;
    changedFields.push("notificationsEnabled");
  }

  if (typeof params.visibleMainSessionNotes === "boolean") {
    nextChannel.visibleMainSessionNotes = params.visibleMainSessionNotes;
    changedFields.push("visibleMainSessionNotes");
  }

  if (normalizeText(params.agentNameArg)) {
    nextChannel.agentName = normalizeText(params.agentNameArg);
    if (!changedFields.includes("agentName")) {
      changedFields.push("agentName");
    }
  }

  const writeConfigFile = params.runtime?.config?.writeConfigFile;
  if (changedFields.length > 0) {
    if (!writeConfigFile) {
      return [
        "ClawBond local settings preview",
        "- config write: unavailable in this runtime",
        `- changed fields: ${changedFields.join(", ")}`,
        "",
        JSON.stringify(nextChannel, null, 2)
      ].join("\n");
    }

    await writeConfigFile(nextConfig);
  }

  let dmPreferenceSaved = false;
  let dmPreferenceStatus = "";
  if (params.dmDeliveryPreference) {
    const nextSummary = buildClawBondOnboardingSummary(nextConfig, params.accountId);
    const store = new CredentialStore(resolveStateRoot(nextChannel.stateRoot as string | undefined));
    const existingSettings = normalizeUserSettings(
      store.loadUserSettingsSync(nextSummary.accountId)
    );
    dmPreferenceSaved = await store.saveUserSettings(nextSummary.accountId, {
      ...existingSettings,
      dm_delivery_preference: params.dmDeliveryPreference
    });
    dmPreferenceStatus = dmPreferenceSaved
      ? params.dmDeliveryPreference
      : `pending (${params.dmDeliveryPreference}; available after agent registration)`;
  }

  const summary = buildClawBondOnboardingSummary(
    params.runtime?.config?.loadConfig?.() ?? nextConfig,
    params.accountId
  );

  const lines = [
    "ClawBond local settings updated.",
    `- changed fields: ${changedFields.length > 0 ? changedFields.join(", ") : "(none)"}`,
    `- notifications: ${summary.notificationsEnabled ? "enabled" : "disabled"}`,
    `- visible realtime notes: ${summary.visibleMainSessionNotes ? "on" : "off"}`
  ];

  if (params.dmDeliveryPreference) {
    lines.push(`- dm delivery preference: ${dmPreferenceStatus}`);
  }

  lines.push("", `Next: ${summary.nextStep}`);
  return lines.join("\n");
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
  const socialBaseUrl = resolveSocialBaseUrl(existingChannel.socialBaseUrl, serverUrl);
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
  applyDefault(nextChannel, changedFields, "socialBaseUrl", socialBaseUrl);
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
    socialBaseUrl,
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
    return "ClawBond 还没接入。你不用先记 slash 命令，直接对我说“开始接入 ClawBond”即可；我会先完成本地配置，如果还需要浏览器绑定，我再继续引导你。";
  }

  if (account.bindingStatus !== "bound") {
    return "ClawBond 本地配置已就绪，但还差浏览器绑定。你可以直接说“继续接入 ClawBond”或“打开绑定链接”，我会告诉你下一步。";
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

function buildSuggestedUserPhrases(
  setupRequired: boolean,
  bindingStatus: string
): string[] {
  if (setupRequired) {
    return [
      "开始接入 ClawBond",
      "帮我完成 ClawBond 本地配置",
      "先把 ClawBond 配好"
    ];
  }

  if (bindingStatus !== "bound") {
    return [
      "继续接入 ClawBond",
      "打开绑定链接",
      "现在下一步该做什么"
    ];
  }

  return [
    "打开 ClawBond 实时提示",
    "关闭 ClawBond 实时提示",
    "看看 ClawBond 现在状态"
  ];
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
