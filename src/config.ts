import type {
  ClawBondAccount,
  ClawBondBindingStatus,
  ClawBondPluginConfig
} from "./types.ts";
import { CredentialStore, resolveStateRoot } from "./credential-store.ts";
import {
  normalizeStructuredMessagePrefix,
  normalizeTrustedSenderAgentIds
} from "./message-envelope.ts";
import { readTrimmedStringOrEmpty } from "./shared-utils.ts";

const DEFAULT_NOTIFICATION_POLL_INTERVAL_MS = 10000;
const MIN_NOTIFICATION_POLL_INTERVAL_MS = 1000;
const MAX_NOTIFICATION_POLL_INTERVAL_MS = 300000;
const DEFAULT_BIND_STATUS_POLL_INTERVAL_MS = 5000;
const MIN_BIND_STATUS_POLL_INTERVAL_MS = 1000;
const MAX_BIND_STATUS_POLL_INTERVAL_MS = 60000;

export function listAccountIds(cfg: { channels?: Record<string, unknown> }): string[] {
  const config = getClawBondConfig(cfg);
  const explicitIds = Object.keys(config.accounts ?? {});
  const stateRoot = resolveStateRoot(readTrimmedStringOrEmpty(config.stateRoot));
  const storedDefault = new CredentialStore(stateRoot).loadSync("default");
  const defaultServerUrl = (
    config.serverUrl ??
    storedDefault?.credentials.platform_base_url ??
    ""
  ).trim();

  if (explicitIds.length > 0) {
    return explicitIds;
  }

  if (
    config.enabled !== false &&
    defaultServerUrl &&
    (hasManualRuntimeConfig(config) || hasBootstrapConfig(config) || Boolean(storedDefault))
  ) {
    return ["default"];
  }

  return [];
}

export function resolveAccount(
  cfg: { channels?: Record<string, unknown> },
  accountId?: string | null
): ClawBondAccount {
  const config = getClawBondConfig(cfg);
  const resolvedAccountId = resolveConfiguredAccountId(cfg, accountId);
  const scoped = config.accounts?.[resolvedAccountId] ?? {};
  const stateRoot = resolveStateRoot(readTrimmedStringOrEmpty(scoped.stateRoot ?? config.stateRoot));
  const stored = new CredentialStore(stateRoot).loadSync(resolvedAccountId);

  const serverUrl = (
    scoped.serverUrl ??
    config.serverUrl ??
    stored?.credentials.platform_base_url ??
    ""
  )
    .trim();
  const apiBaseUrl = resolveApiBaseUrl(serverUrl, scoped.apiBaseUrl ?? config.apiBaseUrl);
  const socialBaseUrl = resolveSocialBaseUrl(
    scoped.socialBaseUrl ?? config.socialBaseUrl ?? stored?.credentials.social_base_url,
    apiBaseUrl || serverUrl
  );
  const connectorToken = (scoped.connectorToken ?? config.connectorToken ?? "").trim();
  const runtimeToken = (
    scoped.runtimeToken ??
    config.runtimeToken ??
    stored?.credentials.agent_access_token ??
    ""
  )
    .trim();
  const agentId = (scoped.agentId ?? config.agentId ?? stored?.credentials.agent_id ?? "").trim();
  const agentName = (
    scoped.agentName ??
    config.agentName ??
    stored?.credentials.agent_name ??
    ""
  )
    .trim();
  const secretKey = (
    scoped.secretKey ??
    config.secretKey ??
    stored?.credentials.secret_key ??
    ""
  )
    .trim();
  const bindCode = (
    scoped.bindCode ??
    config.bindCode ??
    stored?.credentials.bind_code ??
    ""
  )
    .trim();
  const ownerUserId = (stored?.credentials.owner_user_id ?? "").trim();
  const inviteWebBaseUrl = (
    scoped.inviteWebBaseUrl ??
    config.inviteWebBaseUrl ??
    stored?.credentials.invite_web_base_url ??
    ""
  )
    .trim() || resolveInviteWebBaseUrl("", apiBaseUrl || serverUrl);
  const normalizedInviteWebBaseUrl = inviteWebBaseUrl
    .replace(/\/+$/, "");
  const trustedSenderAgentIds = normalizeTrustedSenderAgentIds(
    scoped.trustedSenderAgentIds ?? config.trustedSenderAgentIds
  );
  const structuredMessagePrefix = normalizeStructuredMessagePrefix(
    scoped.structuredMessagePrefix ?? config.structuredMessagePrefix
  );
  const notificationApiUrl = resolveNotificationApiUrl(
    apiBaseUrl || serverUrl,
    scoped.notificationApiUrl ?? config.notificationApiUrl
  );
  const notificationAuthToken = (
    scoped.notificationAuthToken ??
    config.notificationAuthToken ??
    runtimeToken
  )
    .trim();
  const notificationsEnabled = resolveNotificationsEnabled(
    scoped.notificationsEnabled ?? config.notificationsEnabled
  );
  const notificationPollIntervalMs = clampNotificationPollIntervalMs(
    scoped.notificationPollIntervalMs ?? config.notificationPollIntervalMs
  );
  const bindStatusPollIntervalMs = clampBindStatusPollIntervalMs(
    scoped.bindStatusPollIntervalMs ?? config.bindStatusPollIntervalMs
  );
  const visibleMainSessionNotes = resolveVisibleMainSessionNotes(
    scoped.visibleMainSessionNotes ?? config.visibleMainSessionNotes
  );
  const bindingStatus = resolveBindingStatus(
    scoped.bindingStatus ?? config.bindingStatus ?? stored?.credentials.binding_status
  );
  const bootstrapEnabled = resolveBootstrapEnabled(
    scoped.bootstrapEnabled ?? config.bootstrapEnabled,
    { serverUrl, runtimeToken, agentId, secretKey }
  );
  const configured = Boolean(
    serverUrl && ((runtimeToken && agentId) || (agentId && secretKey))
  );
  const enabled = configured && (scoped.enabled ?? config.enabled ?? true);

  return {
    accountId: resolvedAccountId,
    enabled,
    configured,
    serverUrl: serverUrl.replace(/\/+$/, ""),
    apiBaseUrl,
    socialBaseUrl,
    stateRoot,
    bootstrapEnabled,
    connectorToken,
    runtimeToken,
    agentId,
    agentName,
    agentPersona: readTrimmedStringOrEmpty(scoped.agentPersona ?? config.agentPersona),
    agentBio: readTrimmedStringOrEmpty(scoped.agentBio ?? config.agentBio),
    agentTags: readStringArray(scoped.agentTags ?? config.agentTags),
    agentLanguage: readTrimmedStringOrEmpty(scoped.agentLanguage ?? config.agentLanguage),
    secretKey,
    bindCode,
    ownerUserId,
    bindingStatus,
    inviteWebBaseUrl: normalizedInviteWebBaseUrl,
    trustedSenderAgentIds,
    structuredMessagePrefix,
    notificationsEnabled,
    notificationApiUrl,
    notificationAuthToken,
    notificationPollIntervalMs,
    bindStatusPollIntervalMs,
    visibleMainSessionNotes,
    channel: "clawbond"
  };
}

export function resolveSocialBaseUrl(value: unknown, platformBaseUrl: string): string {
  const explicit = readTrimmedStringOrEmpty(value).replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }

  return resolveClawBondDomainBundle(platformBaseUrl).socialBaseUrl;
}

export function resolveInviteWebBaseUrl(value: unknown, platformBaseUrl: string): string {
  const explicit = readTrimmedStringOrEmpty(value).replace(/\/+$/, "");
  if (explicit) {
    return explicit;
  }

  return resolveClawBondDomainBundle(platformBaseUrl).inviteWebBaseUrl;
}

export function resolveClawBondEnvironmentLabel(platformBaseUrl: string): string {
  return resolveClawBondDomainBundle(platformBaseUrl).environment;
}

export function isConfigured(account: ClawBondAccount): boolean {
  return Boolean(account.configured);
}

export function describeAccount(account: ClawBondAccount) {
  return {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: Boolean(account.configured),
    baseUrl: account.serverUrl || undefined,
    apiBaseUrl: account.apiBaseUrl || undefined,
    channelAccessToken: account.runtimeToken ? "***" : undefined,
    bootstrapEnabled: account.bootstrapEnabled,
    bindingStatus: account.bindingStatus,
    agentId: account.agentId || undefined,
    visibleMainSessionNotes: account.visibleMainSessionNotes
  };
}

function getClawBondConfig(cfg: { channels?: Record<string, unknown> }): ClawBondPluginConfig {
  const raw = cfg.channels?.clawbond;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return raw as ClawBondPluginConfig;
}

function resolveConfiguredAccountId(
  cfg: { channels?: Record<string, unknown> },
  accountId?: string | null
): string {
  if (accountId?.trim()) {
    return accountId;
  }

  return listAccountIds(cfg)[0] ?? "default";
}

function resolveNotificationsEnabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return true;
}

function resolveVisibleMainSessionNotes(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return true;
}

function resolveBootstrapEnabled(
  value: unknown,
  params: { serverUrl: string; runtimeToken: string; agentId: string; secretKey: string }
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return Boolean(
    params.serverUrl &&
      params.agentId &&
      (params.secretKey || params.runtimeToken)
  );
}

function clampNotificationPollIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_NOTIFICATION_POLL_INTERVAL_MS;
  }

  return Math.min(
    MAX_NOTIFICATION_POLL_INTERVAL_MS,
    Math.max(MIN_NOTIFICATION_POLL_INTERVAL_MS, Math.trunc(value))
  );
}

function clampBindStatusPollIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BIND_STATUS_POLL_INTERVAL_MS;
  }

  return Math.min(
    MAX_BIND_STATUS_POLL_INTERVAL_MS,
    Math.max(MIN_BIND_STATUS_POLL_INTERVAL_MS, Math.trunc(value))
  );
}

function resolveBindingStatus(value: unknown): ClawBondAccount["bindingStatus"] {
  if (value === "pending" || value === "bound" || value === "unregistered") {
    return value;
  }

  return "unregistered";
}

function resolveApiBaseUrl(serverUrl: string, override: unknown): string {
  return resolveNotificationApiUrl(serverUrl, override);
}

function resolveNotificationApiUrl(serverUrl: string, override: unknown): string {
  if (typeof override === "string" && override.trim()) {
    return normalizeHttpBaseUrl(override.trim());
  }

  if (!serverUrl) {
    return "";
  }

  return normalizeHttpBaseUrl(serverUrl);
}

function resolveClawBondDomainBundle(platformBaseUrl: string): {
  environment: "production" | "development" | "staging" | "custom" | "unknown";
  socialBaseUrl: string;
  inviteWebBaseUrl: string;
} {
  const normalizedPlatform = platformBaseUrl.trim();
  if (!normalizedPlatform) {
    return {
      environment: "unknown",
      socialBaseUrl: "",
      inviteWebBaseUrl: ""
    };
  }

  try {
    const url = new URL(normalizedPlatform);
    const protocol = url.protocol || "https:";
    const hostname = url.hostname.toLowerCase();

    if (hostname === "api.clawbond.ai") {
      return {
        environment: "production",
        socialBaseUrl: `${protocol}//social.clawbond.ai`,
        inviteWebBaseUrl: `${protocol}//clawbond.ai/invite`
      };
    }

    const prefixedMatch = hostname.match(/^([a-z0-9-]+)-api\.clawbond\.ai$/);
    if (prefixedMatch) {
      const prefix = prefixedMatch[1];
      const environment =
        prefix === "dev" ? "development" : prefix === "stg" ? "staging" : "custom";

      return {
        environment,
        socialBaseUrl: `${protocol}//${prefix}-social.clawbond.ai`,
        inviteWebBaseUrl: `${protocol}//${prefix}.clawbond.ai/invite`
      };
    }

    return {
      environment: "custom",
      socialBaseUrl: "",
      inviteWebBaseUrl: ""
    };
  } catch {
    return {
      environment: "unknown",
      socialBaseUrl: "",
      inviteWebBaseUrl: ""
    };
  }
}

function hasManualRuntimeConfig(config: ClawBondPluginConfig): boolean {
  return Boolean(config.runtimeToken?.trim() && config.agentId?.trim());
}

function hasBootstrapConfig(config: ClawBondPluginConfig): boolean {
  return Boolean(
    config.agentId?.trim() && (config.secretKey?.trim() || config.runtimeToken?.trim())
  );
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHttpBaseUrl(value: string): string {
  const url = new URL(value);

  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }

  url.pathname = normalizeBasePath(url.pathname, []);
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
}

function normalizeBasePath(pathname: string, replacementSegments: string[]): string {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lastSegment = segments.at(-1);

  if (lastSegment === "ws" || lastSegment === "api") {
    segments.pop();
  }

  if (replacementSegments.length > 0) {
    segments.push(...replacementSegments);
  }

  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}
