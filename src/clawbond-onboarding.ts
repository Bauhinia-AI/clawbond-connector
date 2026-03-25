import os from "node:os";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import { BootstrapClient } from "./bootstrap-client.ts";
import { resolveAccount, resolveSocialBaseUrl } from "./config.ts";
import {
  buildEffectiveRoutingMatrix,
  CredentialStore,
  getDefaultUserSettings,
  normalizeUserSettings,
  resolveStateRoot
} from "./credential-store.ts";
import type {
  ClawBondReceiveProfile,
  ClawBondRoutingMatrix,
  ClawBondStoredCredentials
} from "./types.ts";

const DEFAULT_SERVER_URL = "https://api.clawbond.ai";
const DEFAULT_INVITE_WEB_BASE_URL = "https://dev.clawbond.ai/invite";
const DEFAULT_STATE_ROOT = "~/.clawbond";
const DEFAULT_NOTIFICATION_POLL_INTERVAL_MS = 10000;
const DEFAULT_BIND_STATUS_POLL_INTERVAL_MS = 5000;

export type ClawBondSetupPlan = {
  nextConfig: OpenClawConfig;
  changedFields: string[];
  agentName: string;
  suggestedAgentName: string;
  serverUrl: string;
  socialBaseUrl: string;
  inviteWebBaseUrl: string;
  stateRoot: string;
  visibleMainSessionNotes: boolean;
};

export type ClawBondOnboardingSummary = {
  accountId: string;
  phase: "setup_required" | "registration_required" | "waiting_for_bind" | "ready";
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
  suggestedAgentName: string;
  notificationsEnabled: boolean;
  visibleMainSessionNotes: boolean;
  receiveProfile: ClawBondReceiveProfile;
  effectiveRoutingMatrix: ClawBondRoutingMatrix;
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
      `- suggested agent name: ${plan.suggestedAgentName}`,
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
  const summary = buildClawBondOnboardingSummary(
    params.runtime?.config?.loadConfig?.() ?? plan.nextConfig
  );

  const lines = [
    "ClawBond setup saved.",
    `- server: ${plan.serverUrl}`,
    `- social: ${plan.socialBaseUrl}`,
    `- stateRoot: ${plan.stateRoot}`,
    `- visible realtime notes: ${plan.visibleMainSessionNotes ? "on" : "off"}`,
    `- changed fields: ${plan.changedFields.length > 0 ? plan.changedFields.join(", ") : "(none)"}`,
    summary.agentName
      ? `- agent name preset: ${summary.agentName}`
      : `- next suggested agent name: ${summary.suggestedAgentName}`,
    "",
    `Next: ${summary.nextStep}`
  ];

  return lines.join("\n");
}

export async function runClawBondRegisterCreate(params: {
  cfg: OpenClawConfig;
  runtime?: PluginRuntime;
  accountId?: string | null;
  agentNameArg?: string | null;
}): Promise<string> {
  const currentConfig = params.runtime?.config?.loadConfig?.() ?? params.cfg;
  const plan = buildClawBondSetupConfig(currentConfig, {
    agentNameArg: params.agentNameArg
  });
  const workingConfig = await persistSetupConfigIfAvailable(plan, params.runtime);
  const summaryBefore = buildClawBondOnboardingSummary(workingConfig, params.accountId);

  if (summaryBefore.phase === "waiting_for_bind" || summaryBefore.phase === "ready") {
    return [
      "ClawBond agent is already registered locally.",
      `- agent: ${summaryBefore.agentName || "(unknown)"}`,
      `- agentId: ${summaryBefore.agentId || "(unknown)"}`,
      `- binding: ${summaryBefore.bindingStatus}`,
      summaryBefore.inviteUrl ? `- invite: ${summaryBefore.inviteUrl}` : "",
      "",
      `Next: ${summaryBefore.nextStep}`
    ]
      .filter(Boolean)
      .join("\n");
  }

  const agentName = normalizeText(params.agentNameArg) || summaryBefore.agentName;
  if (!agentName) {
    throw new Error(
      `ClawBond registration needs an agent name first. Suggested default: ${summaryBefore.suggestedAgentName}`
    );
  }

  const account = resolveAccount(workingConfig, params.accountId);
  const apiBaseUrl = account.apiBaseUrl || account.serverUrl;
  if (!apiBaseUrl) {
    throw new Error("ClawBond registration requires apiBaseUrl or serverUrl");
  }

  const bootstrapClient = new BootstrapClient(apiBaseUrl);
  const registration = await bootstrapClient.registerAgent({
    name: agentName,
    persona: account.agentPersona,
    bio: account.agentBio,
    tags: account.agentTags,
    language: account.agentLanguage
  });

  const store = new CredentialStore(account.stateRoot);
  await store.save(account.accountId, {
    platform_base_url: apiBaseUrl,
    social_base_url: account.socialBaseUrl || undefined,
    agent_access_token: registration.accessToken,
    agent_id: registration.agentId,
    agent_name: agentName,
    secret_key: registration.secretKey,
    bind_code: registration.bindCode,
    binding_status: "pending",
    invite_web_base_url: account.inviteWebBaseUrl || undefined
  });

  const summary = buildClawBondOnboardingSummary(workingConfig, params.accountId);
  return [
    "ClawBond agent registered.",
    `- agent: ${summary.agentName}`,
    `- agentId: ${summary.agentId}`,
    `- binding: ${summary.bindingStatus}`,
    summary.inviteUrl ? `- invite: ${summary.inviteUrl}` : "",
    "",
    `Next: ${summary.nextStep}`
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runClawBondRegisterBind(params: {
  cfg: OpenClawConfig;
  runtime?: PluginRuntime;
  accountId?: string | null;
}): Promise<string> {
  const currentConfig = params.runtime?.config?.loadConfig?.() ?? params.cfg;
  const summaryBefore = buildClawBondOnboardingSummary(currentConfig, params.accountId);

  if (summaryBefore.phase === "setup_required") {
    return [
      "ClawBond setup is still missing.",
      `Next: ${summaryBefore.nextStep}`
    ].join("\n");
  }

  if (summaryBefore.phase === "registration_required") {
    return [
      "ClawBond agent has not been registered yet.",
      `- suggested agent name: ${summaryBefore.suggestedAgentName}`,
      "",
      `Next: ${summaryBefore.nextStep}`
    ].join("\n");
  }

  const account = resolveAccount(currentConfig, params.accountId);
  const apiBaseUrl = account.apiBaseUrl || account.serverUrl;
  if (!apiBaseUrl) {
    throw new Error("ClawBond binding check requires apiBaseUrl or serverUrl");
  }

  const bootstrapClient = new BootstrapClient(apiBaseUrl);
  let accessToken = account.runtimeToken.trim();
  if (account.agentId.trim() && account.secretKey.trim()) {
    accessToken = await bootstrapClient.refreshAgentToken(account.agentId, account.secretKey);
  }

  if (!accessToken) {
    throw new Error("ClawBond binding check requires a local agent session");
  }

  const profile = await bootstrapClient.getMe(accessToken);
  const bindStatus = await bootstrapClient.getBindStatus(accessToken);
  const store = new CredentialStore(account.stateRoot);
  await store.save(account.accountId, buildStoredCredentials({
    account,
    accessToken,
    agentId: profile.id,
    agentName: profile.name,
    secretKey: account.secretKey,
    bindCode: profile.bindCode?.trim() || account.bindCode,
    ownerUserId: bindStatus.userId?.trim() || profile.userId?.trim() || account.ownerUserId,
    bindingStatus: bindStatus.bound ? "bound" : "pending"
  }));

  const summary = buildClawBondOnboardingSummary(currentConfig, params.accountId);
  if (summary.bindingStatus === "bound") {
    return [
      "ClawBond binding is complete.",
      `- agent: ${summary.agentName}`,
      `- agentId: ${summary.agentId}`,
      `- binding: ${summary.bindingStatus}`,
      "",
      `Next: ${summary.nextStep}`
    ].join("\n");
  }

  return [
    "ClawBond is still waiting for browser binding.",
    `- agent: ${summary.agentName || "(not set)"}`,
    `- agentId: ${summary.agentId || "(not set)"}`,
    summary.inviteUrl ? `- invite: ${summary.inviteUrl}` : "",
    "",
    `Next: ${summary.nextStep}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildClawBondOnboardingSummary(
  cfg: OpenClawConfig,
  accountId?: string | null
): ClawBondOnboardingSummary {
  const account = resolveAccount(cfg, accountId);
  const rawChannel = readRecord(readRecord(cfg.channels).clawbond);
  const channelStateRoot = resolveStateRoot(normalizeText(rawChannel.stateRoot));
  const store = new CredentialStore(channelStateRoot);
  const stored = store.loadSync(account.accountId);
  const settings = stored
    ? store.loadUserSettingsSync(account.accountId)
    : getDefaultUserSettings();
  const inviteUrl = buildInviteUrl(account);
  const configBlockPresent = Object.keys(rawChannel).length > 0;
  const hasLocalAgentIdentity = Boolean(
    (account.agentId && (account.secretKey || account.runtimeToken)) || stored
  );
  const phase = resolveRegistrationPhase({
    configBlockPresent,
    serverUrl: account.serverUrl,
    hasLocalAgentIdentity,
    bindingStatus: account.bindingStatus
  });

  return {
    accountId: account.accountId,
    phase,
    configured: Boolean(account.configured),
    configBlockPresent,
    localCredentialsFound: Boolean(stored),
    bindingStatus: account.bindingStatus,
    nextStep: describeDoctorNextStep({
      phase,
      inviteUrl,
      suggestedAgentName: buildSuggestedAgentName()
    }),
    inviteUrl,
    serverUrl: account.serverUrl,
    socialBaseUrl: account.socialBaseUrl,
    agentName: account.agentName || stored?.credentials.agent_name || "",
    agentId: account.agentId || stored?.credentials.agent_id || "",
    suggestedAgentName: buildSuggestedAgentName(),
    notificationsEnabled: account.notificationsEnabled,
    visibleMainSessionNotes: account.visibleMainSessionNotes,
    receiveProfile: settings.receive_profile,
    effectiveRoutingMatrix: buildEffectiveRoutingMatrix(settings),
    suggestedUserPhrases: buildSuggestedUserPhrases(phase),
    manualFallbackCommands: [
      "/clawbond setup",
      "/clawbond register <agentName>",
      "/clawbond bind",
      "/clawbond status"
    ]
  };
}

export async function runClawBondLocalConfigUpdate(params: {
  cfg: OpenClawConfig;
  runtime?: PluginRuntime;
  accountId?: string | null;
  notificationsEnabled?: boolean;
  visibleMainSessionNotes?: boolean;
}): Promise<string> {
  const currentConfig = params.runtime?.config?.loadConfig?.() ?? params.cfg;
  const setupPlan = buildClawBondSetupConfig(currentConfig);
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

  const explicitAgentName = normalizeText(options?.agentNameArg);
  const existingAgentName = normalizeText(existingChannel.agentName);
  const suggestedAgentName = buildSuggestedAgentName();
  const agentName = explicitAgentName || existingAgentName || "";
  const serverUrl = normalizeText(existingChannel.serverUrl) || DEFAULT_SERVER_URL;
  const socialBaseUrl = resolveSocialBaseUrl(existingChannel.socialBaseUrl, serverUrl);
  const inviteWebBaseUrl =
    normalizeText(existingChannel.inviteWebBaseUrl) || DEFAULT_INVITE_WEB_BASE_URL;
  const stateRoot = normalizeText(existingChannel.stateRoot) || DEFAULT_STATE_ROOT;
  const visibleMainSessionNotes =
    typeof existingChannel.visibleMainSessionNotes === "boolean"
      ? existingChannel.visibleMainSessionNotes
      : true;

  const nextChannel: Record<string, unknown> = { ...existingChannel };

  applyDefault(nextChannel, changedFields, "enabled", true);
  applyDefault(nextChannel, changedFields, "serverUrl", serverUrl);
  applyDefault(nextChannel, changedFields, "socialBaseUrl", socialBaseUrl);
  applyDefault(nextChannel, changedFields, "inviteWebBaseUrl", inviteWebBaseUrl);
  applyDefault(nextChannel, changedFields, "stateRoot", stateRoot);
  if (existingAgentName) {
    applyDefault(nextChannel, changedFields, "agentName", existingAgentName);
  }
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
  applyDefault(nextChannel, changedFields, "visibleMainSessionNotes", true);

  if (explicitAgentName) {
    nextChannel.agentName = explicitAgentName;
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
    suggestedAgentName,
    serverUrl,
    socialBaseUrl,
    inviteWebBaseUrl,
    stateRoot,
    visibleMainSessionNotes
  };
}

export function buildClawBondDoctorReport(
  cfg: OpenClawConfig,
  accountId?: string | null,
  serverWsStatus?: boolean | null
): string {
  const summary = buildClawBondOnboardingSummary(cfg, accountId);
  const account = resolveAccount(cfg, accountId);
  const rawChannel = readRecord(readRecord(cfg.channels).clawbond);
  const stored = new CredentialStore(resolveStateRoot(normalizeText(rawChannel.stateRoot))).loadSync(
    summary.accountId
  );
  const installSpec = readPluginInstallSpec(cfg);
  const installTracking = describeInstallTracking(installSpec);

  const lines = [
    `ClawBond doctor (${summary.accountId})`,
    "- plugin: loaded",
    `- phase: ${summary.phase}`,
    `- config block: ${summary.configBlockPresent ? "present" : "missing"}`,
    `- install tracking: ${installTracking}`,
    `- local credentials: ${stored ? "found" : "missing"}`,
    `- server: ${account.serverUrl || "(not configured)"}`,
    `- agent: ${summary.agentName || "(not set)"}`,
    `- agentId: ${summary.agentId || "(none)"}`,
    `- binding: ${summary.bindingStatus}`,
    `- notifications: ${summary.notificationsEnabled ? "enabled" : "disabled"}`,
    `- visible realtime notes: ${summary.visibleMainSessionNotes ? "on" : "off"}`,
    `- receive_profile: ${summary.receiveProfile} (fixed local default)`,
    `- server_ws: ${formatDoctorServerWsStatus(serverWsStatus)} (managed by web)`,
    summary.inviteUrl ? `- invite: ${summary.inviteUrl}` : "",
    summary.agentName ? "" : `- suggested agent name: ${summary.suggestedAgentName}`,
    "",
    `Next: ${summary.nextStep}`
  ];

  return lines.filter(Boolean).join("\n");
}

function formatDoctorServerWsStatus(value: boolean | null | undefined): string {
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  return "unknown (could not fetch remote capabilities)";
}

export function buildClawBondWelcomeMessage(cfg: OpenClawConfig): string | null {
  const summary = buildClawBondOnboardingSummary(cfg);

  if (summary.phase === "setup_required") {
    return "ClawBond 还没接入。你不用先记 slash 命令，直接对我说“开始接入 ClawBond”即可；我会先完成本地配置。";
  }

  if (summary.phase === "registration_required") {
    return `ClawBond 本地配置已就绪，但还没注册 agent。先告诉我你想在 ClawBond 上用什么名字；如果你不在意，我可以直接用 ${summary.suggestedAgentName}。`;
  }

  if (summary.phase === "waiting_for_bind") {
    return "ClawBond 已经注册，但还差浏览器绑定。你可以直接说“继续绑定 ClawBond”或“打开绑定链接”，我会告诉你下一步。";
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

function resolveRegistrationPhase(params: {
  configBlockPresent: boolean;
  serverUrl: string;
  hasLocalAgentIdentity: boolean;
  bindingStatus: string;
}): ClawBondOnboardingSummary["phase"] {
  if (!params.configBlockPresent || !params.serverUrl) {
    return "setup_required";
  }

  if (!params.hasLocalAgentIdentity) {
    return "registration_required";
  }

  return params.bindingStatus === "bound" ? "ready" : "waiting_for_bind";
}

function describeDoctorNextStep(params: {
  phase: ClawBondOnboardingSummary["phase"];
  inviteUrl: string | null;
  suggestedAgentName: string;
}): string {
  switch (params.phase) {
    case "setup_required":
      return "finish local setup first";
    case "registration_required":
      return `ask for an agent name, then register it (suggested default: ${params.suggestedAgentName})`;
    case "waiting_for_bind":
      return params.inviteUrl
        ? `finish binding in the browser, then re-check registration status (${params.inviteUrl})`
        : "finish browser binding, then re-check registration status";
    case "ready":
    default:
      return "ClawBond is ready; try `/clawbond inbox` or just keep chatting";
  }
}

function buildSuggestedUserPhrases(
  phase: ClawBondOnboardingSummary["phase"]
): string[] {
  switch (phase) {
    case "setup_required":
      return [
        "开始接入 ClawBond",
        "帮我完成 ClawBond 本地配置",
        "先把 ClawBond 配好"
      ];
    case "registration_required":
      return [
        "帮我注册 ClawBond agent",
        "用这个名字注册 ClawBond",
        "先给这个 agent 起个注册名"
      ];
    case "waiting_for_bind":
      return [
        "继续绑定 ClawBond",
        "打开绑定链接",
        "现在下一步该做什么"
      ];
    case "ready":
    default:
      return [
        "打开 ClawBond 实时提示",
        "关闭 ClawBond 实时提示",
        "看看 ClawBond 现在状态"
      ];
  }
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

async function persistSetupConfigIfAvailable(
  plan: ClawBondSetupPlan,
  runtime?: PluginRuntime
): Promise<OpenClawConfig> {
  const writeConfigFile = runtime?.config?.writeConfigFile;
  if (writeConfigFile) {
    await writeConfigFile(plan.nextConfig);
    return runtime?.config?.loadConfig?.() ?? plan.nextConfig;
  }

  return plan.nextConfig;
}

function buildStoredCredentials(params: {
  account: ReturnType<typeof resolveAccount>;
  accessToken: string;
  agentId: string;
  agentName: string;
  secretKey: string;
  bindCode: string;
  ownerUserId?: string;
  bindingStatus: "pending" | "bound";
}): ClawBondStoredCredentials {
  return {
    platform_base_url: params.account.apiBaseUrl || params.account.serverUrl,
    social_base_url: params.account.socialBaseUrl || undefined,
    agent_access_token: params.accessToken,
    agent_id: params.agentId,
    agent_name: params.agentName,
    secret_key: params.secretKey,
    bind_code: params.bindCode || undefined,
    owner_user_id: params.ownerUserId || undefined,
    binding_status: params.bindingStatus,
    invite_web_base_url: params.account.inviteWebBaseUrl || undefined
  };
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
