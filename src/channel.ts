import { createHash } from "node:crypto";

import {
  type ChannelAccountSnapshot,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
  type ChannelGatewayContext,
  type ChannelPlugin,
  type OpenClawConfig
} from "openclaw/plugin-sdk";

import { ClawBondActivityStore } from "./activity-store.ts";
import { BootstrapClient } from "./bootstrap-client.ts";
import { ClawBondServerApiClient } from "./clawbond-api.ts";
import { describeAccount, isConfigured, resolveAccount, listAccountIds } from "./config.ts";
import { CredentialStore } from "./credential-store.ts";
import { ClawBondInboxStore } from "./inbox-store.ts";
import { sanitizeLogString, sanitizeLogValue } from "./log-sanitizer.ts";
import { clearClawBondMainWakeQueue, enqueueClawBondMainWake } from "./main-wake-store.ts";
import { resolveStructuredIncomingPrompt } from "./message-envelope.ts";
import { getClawBondRuntime } from "./runtime.ts";
import { NotificationClient } from "./notification-client.ts";
import {
  queueMainSessionChatSend,
  queueMainSessionWakeEvent,
  queueMainSessionVisibleNote,
  CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE
} from "./openclaw-cli.ts";
import { PlatformClient } from "./platform-client.ts";
import type {
  ClawBondAccount,
  ClawBondAgentBindStatus,
  ClawBondAgentSelfProfile,
  ClawBondBindingStatus,
  ClawBondInvokeMessage,
  ClawBondStoredCredentials
} from "./types.ts";

const CHANNEL_ID = "clawbond" as const;
const PLATFORM_LABEL = "ClawBond";
const DEFAULT_ACCOUNT_ID = "default";
const MAIN_SESSION_KEY = "agent:main:main";
const MAIN_WAKE_DEBOUNCE_MS = 400;
const DM_MERGED_WAKE_COOLDOWN_MS = 90_000;

const runtimeClients = new Map<string, PlatformClient>();
const pendingMainWakeTimers = new Map<string, NodeJS.Timeout>();
const pendingMainWakeItemIds = new Map<string, Set<string>>();
type StartAccountContext = ChannelGatewayContext<ClawBondAccount>;
type ClawBondStatusSnapshot = ChannelAccountSnapshot & {
  agentId?: string;
  agentName?: string;
  bindCode?: string;
  bindingStatus?: ClawBondBindingStatus;
  busy?: boolean;
  connected?: boolean;
  inviteUrl?: string;
  lastError?: string | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastRunActivityAt?: number | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  linked?: boolean;
  message?: string;
  phase?: string;
  reconnectAttempts?: number;
  restartPending?: boolean;
  running?: boolean;
};

type BootstrapState = {
  accessToken: string;
  agentId: string;
  agentName: string;
  secretKey: string;
  bindCode: string;
  bindingStatus: Exclude<ClawBondBindingStatus, "unregistered">;
  ownerUserId?: string;
};

type ConnectedSessionExit =
  | {
      kind: "aborted";
    }
  | {
      kind: "binding_lost";
      account: ClawBondAccount;
    };

export const clawbondPlugin: ChannelPlugin<ClawBondAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: PLATFORM_LABEL,
    selectionLabel: PLATFORM_LABEL,
    docsPath: "/channels/clawbond",
    docsLabel: "clawbond",
    blurb: "Connect a local OpenClaw runtime to the ClawBond public agent platform.",
    order: 110
  },
  reload: {
    configPrefixes: ["channels.clawbond"]
  },
  config: {
    listAccountIds,
    resolveAccount,
    isConfigured,
    describeAccount
  },
  capabilities: {
    chatTypes: ["direct"]
  },
  status: {
    defaultRuntime: createDefaultStatusRuntime(DEFAULT_ACCOUNT_ID),
    buildChannelSummary: ({ snapshot }) => buildChannelSummary(snapshot as ClawBondStatusSnapshot),
    buildAccountSnapshot: ({ account, runtime }) => buildAccountSnapshot(account, runtime)
  },
  gateway: {
    async startAccount(ctx) {
      let activeAccount = ctx.account;
      let failed = false;
      const store = new CredentialStore(activeAccount.stateRoot);
      const bootstrapClient = new BootstrapClient(activeAccount.apiBaseUrl || activeAccount.serverUrl);
      const serverApi = new ClawBondServerApiClient(activeAccount.apiBaseUrl || activeAccount.serverUrl);
      let refreshRuntimeTokenPromise: Promise<string> | null = null;
      const peerLabelCache = new Map<string, string>();

      setAccountStatus(ctx, activeAccount, {
        phase: activeAccount.bootstrapEnabled ? "bootstrapping" : "starting",
        busy: activeAccount.bootstrapEnabled,
        connected: false,
        message: activeAccount.bootstrapEnabled
          ? "Preparing ClawBond session recovery"
          : "Preparing ClawBond connection"
      });

      try {
        if (activeAccount.bootstrapEnabled) {
          activeAccount = await bootstrapAccount(ctx, activeAccount);
        }

        const refreshRuntimeToken = async (reason: string): Promise<string> => {
          if (!canRefreshRuntimeToken(activeAccount)) {
            const currentToken = activeAccount.runtimeToken.trim();
            if (!currentToken) {
              throw new Error(`Cannot ${reason}: missing ClawBond runtime token`);
            }

            return currentToken;
          }

          if (!refreshRuntimeTokenPromise) {
            refreshRuntimeTokenPromise = (async () => {
              const nextToken = await bootstrapClient.refreshAgentToken(
                activeAccount.agentId,
                activeAccount.secretKey
              );
              applyRuntimeToken(activeAccount, nextToken);
              await persistRuntimeCredentials(store, activeAccount);
              logInfo(ctx, "[clawbond-connector] refreshed runtime token", {
                agentId: activeAccount.agentId,
                reason
              });
              return nextToken;
            })().finally(() => {
              refreshRuntimeTokenPromise = null;
            });
          }

          return refreshRuntimeTokenPromise;
        };

        const requestWithRuntimeToken = async <T>(
          label: string,
          request: (accessToken: string) => Promise<T>
        ): Promise<T> => {
          const currentToken = activeAccount.runtimeToken.trim();

          if (currentToken) {
            try {
              return await request(currentToken);
            } catch (error) {
              if (!shouldRetryWithTokenRefresh(activeAccount, error)) {
                throw error;
              }
            }
          }

          const refreshedToken = await refreshRuntimeToken(`refresh ${label}`);
          return request(refreshedToken);
        };

        while (true) {
          throwIfAborted(ctx.abortSignal);

          const sessionExit = await runConnectedSession({
            ctx,
            account: activeAccount,
            store,
            bootstrapClient,
            resolveRuntimeToken: async (reason) =>
              reason === "reconnect"
                ? refreshRuntimeToken("reconnect ClawBond realtime gateway")
                : activeAccount.runtimeToken.trim(),
            pollMessages: (after, limit) =>
              requestWithRuntimeToken("poll messages", (accessToken) =>
                serverApi.pollMessages(accessToken, after, limit)
              ),
            loadBindStatus: () =>
              requestWithRuntimeToken("bind status", (accessToken) =>
                bootstrapClient.getBindStatus(accessToken)
              ),
            loadProfile: () =>
              requestWithRuntimeToken("agent profile", (accessToken) =>
                bootstrapClient.getMe(accessToken)
              ),
            resolvePeerLabel: (message) =>
              requestWithRuntimeToken("sender label", (accessToken) =>
                resolveRealtimePeerLabel({
                  api: serverApi,
                  accessToken,
                  message,
                  cache: peerLabelCache
                })
              )
          });

          if (sessionExit.kind === "binding_lost") {
            if (!canRefreshRuntimeToken(sessionExit.account)) {
              throw new Error(
                "ClawBond binding was removed and cannot be recovered automatically without agentId and secretKey"
              );
            }

            activeAccount = await bootstrapAccount(ctx, sessionExit.account);
            continue;
          }

          return;
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        failed = true;
        setAccountStatus(ctx, activeAccount, {
          phase: "error",
          busy: false,
          connected: false,
          message: stringifyError(error),
          lastError: stringifyError(error)
        });

        throw error;
      } finally {
        if (!failed) {
          setAccountStatus(ctx, activeAccount, {
            phase: "stopped",
            busy: false,
            connected: false,
            message: ctx.abortSignal.aborted
              ? "ClawBond channel stopped"
              : "ClawBond channel disconnected"
          });
        }
      }
    }
  },
  outbound: {
    deliveryMode: "direct",
    sendPayload: async (ctx) => {
      const account = resolveOutboundAccount(ctx.cfg, ctx.accountId);
      const client = requirePlatformClient(account.accountId);
      const content = formatTextWithAttachmentLinks(
        ctx.payload.text,
        resolveOutboundMediaUrls(ctx.payload)
      );

      if (!content) {
        return buildDeliveryResult(ctx.to);
      }

      await client.sendReply({
        type: "reply",
        agentId: account.agentId,
        toAgentId: normalizeTarget(ctx.to),
        content
      });

      return buildDeliveryResult(ctx.to);
    },
    sendText: async (ctx) => {
      const account = resolveOutboundAccount(ctx.cfg, ctx.accountId);
      const client = requirePlatformClient(account.accountId);
      const content = ctx.text.trim();

      if (!content) {
        return buildDeliveryResult(ctx.to);
      }

      await client.sendReply({
        type: "reply",
        agentId: account.agentId,
        toAgentId: normalizeTarget(ctx.to),
        content
      });

      return buildDeliveryResult(ctx.to);
    }
  }
};

async function bootstrapAccount(
  ctx: StartAccountContext,
  account: ClawBondAccount
): Promise<ClawBondAccount> {
  throwIfAborted(ctx.abortSignal);

  const apiBaseUrl = account.apiBaseUrl || account.serverUrl;
  if (!apiBaseUrl) {
    throw new Error("ClawBond registration recovery requires apiBaseUrl or serverUrl");
  }

  const store = new CredentialStore(account.stateRoot);
  const bootstrapClient = new BootstrapClient(apiBaseUrl);

  let state: BootstrapState = {
    accessToken: account.runtimeToken.trim(),
    agentId: account.agentId.trim(),
    agentName: account.agentName.trim(),
    secretKey: account.secretKey.trim(),
    bindCode: account.bindCode.trim(),
    bindingStatus: account.bindingStatus === "bound" ? "bound" : "pending"
  };

  if (!state.agentId || (!state.secretKey && !state.accessToken)) {
    throw new Error(
      "ClawBond runtime start requires an already registered local agent. Ask the agent to run ClawBond register first."
    );
  }

  if (!state.accessToken) {
    setAccountStatus(ctx, account, {
      phase: "refreshing_token",
      busy: true,
      connected: false,
      bindingStatus: state.bindingStatus,
      message: "Refreshing ClawBond session"
    });

    state.accessToken = await bootstrapClient.refreshAgentToken(state.agentId, state.secretKey);
  }

  const preBindProfile = await bootstrapClient.getMe(state.accessToken);
  state = {
    ...state,
    agentId: preBindProfile.id,
    agentName: preBindProfile.name,
    bindCode: preBindProfile.bindCode?.trim() || state.bindCode,
    ownerUserId: preBindProfile.userId?.trim() || state.ownerUserId
  };

  let bindStatus = await bootstrapClient.getBindStatus(state.accessToken);
  if (bindStatus.bound) {
    state = {
      ...state,
      bindingStatus: "bound",
      ownerUserId: bindStatus.userId?.trim() || state.ownerUserId
    };
  } else {
    state.bindingStatus = "pending";
    await saveBootstrapCredentials(store, account, state);

    if (account.connectorToken) {
      setAccountStatus(ctx, account, {
        phase: "binding",
        busy: true,
        connected: false,
        bindingStatus: "pending",
        agentId: state.agentId,
        agentName: state.agentName,
        bindCode: state.bindCode || undefined,
        message: "Binding agent to the provided human connector token"
      });

      bindStatus = await bootstrapClient.bindAgent(state.accessToken, account.connectorToken);
      if (!bindStatus.bound) {
        throw new Error("ClawBond bind API did not complete the agent binding");
      }

      state = {
        ...state,
        bindingStatus: "bound",
        ownerUserId: bindStatus.userId?.trim() || state.ownerUserId
      };
    } else {
      setAccountStatus(ctx, account, {
        phase: "waiting_for_bind",
        busy: true,
        connected: false,
        bindingStatus: "pending",
        agentId: state.agentId,
        agentName: state.agentName,
        bindCode: state.bindCode || undefined,
        inviteUrl: buildInviteUrl(bootstrapClient, state.bindCode, account.inviteWebBaseUrl) || undefined,
        message: "Waiting for the human to finish ClawBond binding"
      });

      bindStatus = await waitForBoundStatus({
        abortSignal: ctx.abortSignal,
        bootstrapClient,
        accessToken: state.accessToken,
        pollIntervalMs: account.bindStatusPollIntervalMs,
        onPending: () => {
          setAccountStatus(ctx, account, {
            phase: "waiting_for_bind",
            busy: true,
            connected: false,
            bindingStatus: "pending",
            agentId: state.agentId,
            agentName: state.agentName,
            bindCode: state.bindCode || undefined,
            inviteUrl: buildInviteUrl(bootstrapClient, state.bindCode, account.inviteWebBaseUrl) || undefined,
            message: "Waiting for the human to finish ClawBond binding"
          });
        }
      });

      state = {
        ...state,
        bindingStatus: "bound",
        ownerUserId: bindStatus.userId?.trim() || state.ownerUserId
      };
    }
  }

  setAccountStatus(ctx, account, {
    phase: "refreshing_token",
    busy: true,
    connected: false,
    bindingStatus: state.bindingStatus,
    agentId: state.agentId,
    agentName: state.agentName,
    bindCode: state.bindCode || undefined,
    message: "Refreshing ClawBond session after binding"
  });

  state.accessToken = await bootstrapClient.refreshAgentToken(state.agentId, state.secretKey);

  const boundProfile = await bootstrapClient.getMe(state.accessToken);
  state = {
    ...state,
    agentId: boundProfile.id,
    agentName: boundProfile.name,
    bindCode: boundProfile.bindCode?.trim() || state.bindCode,
    ownerUserId: boundProfile.userId?.trim() || state.ownerUserId,
    bindingStatus: "bound"
  };

  await saveBootstrapCredentials(store, account, state);

  const bootstrapped = applyBootstrapState(account, state);
  setAccountStatus(ctx, bootstrapped, {
    phase: "bound",
    busy: true,
    connected: false,
    bindingStatus: "bound",
    message: "ClawBond binding completed"
  });

  return bootstrapped;
}

async function waitForBoundStatus(params: {
  abortSignal: AbortSignal;
  bootstrapClient: BootstrapClient;
  accessToken: string;
  pollIntervalMs: number;
  onPending?: () => void;
}) {
  while (true) {
    throwIfAborted(params.abortSignal);

    const status = await params.bootstrapClient.getBindStatus(params.accessToken);
    if (status.bound) {
      return status;
    }

    params.onPending?.();
    await sleepWithAbort(params.abortSignal, params.pollIntervalMs);
  }
}

async function saveBootstrapCredentials(
  store: CredentialStore,
  account: ClawBondAccount,
  state: BootstrapState
) {
  const credentials: ClawBondStoredCredentials = {
    platform_base_url: account.apiBaseUrl || account.serverUrl,
    social_base_url: account.socialBaseUrl || undefined,
    agent_access_token: state.accessToken,
    agent_id: state.agentId,
    agent_name: state.agentName,
    secret_key: state.secretKey,
    binding_status: state.bindingStatus,
    bind_code: state.bindCode || undefined,
    owner_user_id: state.ownerUserId || undefined,
    invite_web_base_url: account.inviteWebBaseUrl || undefined
  };

  await store.save(account.accountId, credentials);
}

function applyBootstrapState(account: ClawBondAccount, state: BootstrapState): ClawBondAccount {
  const keepCustomNotificationToken =
    account.notificationAuthToken.trim() && account.notificationAuthToken.trim() !== account.runtimeToken.trim();

  return {
    ...account,
    configured: true,
    runtimeToken: state.accessToken,
    agentId: state.agentId,
    agentName: state.agentName,
    secretKey: state.secretKey,
    bindCode: state.bindCode,
    ownerUserId: state.ownerUserId || "",
    bindingStatus: state.bindingStatus,
    notificationAuthToken: keepCustomNotificationToken
      ? account.notificationAuthToken
      : state.accessToken
  };
}

async function runConnectedSession(params: {
  ctx: StartAccountContext;
  account: ClawBondAccount;
  store: CredentialStore;
  bootstrapClient: BootstrapClient;
  resolveRuntimeToken: (reason: "initial_connect" | "reconnect") => Promise<string>;
  pollMessages: (after: string | undefined, limit: number) => Promise<{
    data: unknown[];
    pagination?: unknown;
  }>;
  loadBindStatus: () => Promise<ClawBondAgentBindStatus>;
  loadProfile: () => Promise<ClawBondAgentSelfProfile>;
  resolvePeerLabel: (message: ClawBondInvokeMessage) => Promise<string | null>;
}): Promise<ConnectedSessionExit> {
  let client: PlatformClient | null = null;
  let notificationClient: NotificationClient | null = null;
  let bindingMonitor:
    | {
        completion: Promise<ClawBondAccount | null>;
        stop: () => void;
      }
    | null = null;
  let initialRealtimeConnected = false;
  let dmCatchUpPromise: Promise<void> | null = null;

  const runRuntimeDmCatchUp = async (reason: "initial_start" | "reconnect") => {
    if (!dmCatchUpPromise) {
      dmCatchUpPromise = syncRuntimeDmCatchUp({
        ctx: params.ctx,
        account: params.account,
        store: params.store,
        pollMessages: params.pollMessages,
        resolvePeerLabel: params.resolvePeerLabel,
        reason
      }).finally(() => {
        dmCatchUpPromise = null;
      });
    }

    return dmCatchUpPromise;
  };

  try {
    client = new PlatformClient(params.account, {
      resolveRuntimeToken: params.resolveRuntimeToken
    });
    notificationClient = new NotificationClient(params.account);

    client.on("log", (entry) => {
      logInfo(params.ctx, "[clawbond-connector] platform client", entry);
    });

    client.on("invoke", (message: ClawBondInvokeMessage) => {
      void dispatchPlatformInvoke(params.ctx, params.account, message, params.resolvePeerLabel).catch((error) => {
        logError(params.ctx, "[clawbond-connector] inbound dispatch crashed", {
          error: stringifyError(error),
          requestId: message.requestId
        });
      });
    });

    notificationClient.setConsumer(async (notification, meta) => {
      await dispatchPlatformInvoke(
        params.ctx,
        params.account,
        notificationClient!.buildInvokeMessageWithPath(notification, meta.deliveryPath),
        params.resolvePeerLabel
      );
    });

    client.on("connected", () => {
      if (!initialRealtimeConnected) {
        initialRealtimeConnected = true;
        return;
      }

      void Promise.all([
        notificationClient!.onRealtimeConnected(),
        runRuntimeDmCatchUp("reconnect")
      ]).catch((error) => {
        logWarn(params.ctx, "[clawbond-connector] runtime catch-up after realtime reconnect failed", {
          error: stringifyError(error)
        });
      });
    });

    client.on("disconnected", () => {
      notificationClient!.onRealtimeDisconnected();
    });

    client.on("notification", (notification) => {
      void notificationClient!
        .processIncomingNotification(notification)
        .catch((error) => {
          logError(params.ctx, "[clawbond-connector] realtime notification dispatch crashed", {
            error: stringifyError(error),
            notificationId: notification.id
          });
        });
    });

    client.on("reply", () => {
      markOutboundSuccess(params.ctx, params.account);
    });

    notificationClient.on("log", (entry) => {
      logInfo(params.ctx, "[clawbond-connector] notification client", entry);
    });

    setAccountStatus(params.ctx, params.account, {
      phase: "connecting",
      busy: false,
      connected: false,
      bindingStatus: params.account.bindingStatus,
      message: "Connecting to ClawBond realtime gateway"
    });

    await client.start();
    runtimeClients.set(params.account.accountId, client);
    await notificationClient.start({ enablePollingFallback: false });
    try {
      await runRuntimeDmCatchUp("initial_start");
    } catch (error) {
      logWarn(params.ctx, "[clawbond-connector] initial runtime DM catch-up failed", {
        error: stringifyError(error)
      });
    }

    setAccountStatus(params.ctx, params.account, {
      phase: "connected",
      busy: false,
      connected: true,
      bindingStatus: params.account.bindingStatus,
      lastConnectedAt: Date.now(),
      lastError: null,
      message: "Connected to ClawBond"
    });

    bindingMonitor = createRuntimeBindingMonitor({
      ctx: params.ctx,
      account: params.account,
      store: params.store,
      bootstrapClient: params.bootstrapClient,
      loadBindStatus: params.loadBindStatus,
      loadProfile: params.loadProfile
    });

    const bindingLostAccount = await Promise.race([
      waitUntilAbort(params.ctx.abortSignal).then(() => null),
      bindingMonitor.completion
    ]);

    if (bindingLostAccount) {
      return {
        kind: "binding_lost",
        account: bindingLostAccount
      };
    }

    return {
      kind: "aborted"
    };
  } finally {
    clearScheduledMainSessionWork(params.account.accountId);
    bindingMonitor?.stop();
    runtimeClients.delete(params.account.accountId);
    await notificationClient?.stop().catch(() => undefined);
    await client?.stop().catch(() => undefined);
  }
}

function createRuntimeBindingMonitor(params: {
  ctx: StartAccountContext;
  account: ClawBondAccount;
  store: CredentialStore;
  bootstrapClient: BootstrapClient;
  loadBindStatus: () => Promise<ClawBondAgentBindStatus>;
  loadProfile: () => Promise<ClawBondAgentSelfProfile>;
}) {
  const stopController = new AbortController();
  const signal = combineAbortSignals([params.ctx.abortSignal, stopController.signal]);

  return {
    completion: (async () => {
      while (true) {
        try {
          await sleepWithAbort(signal, params.account.bindStatusPollIntervalMs);
        } catch (error) {
          if (isAbortError(error)) {
            return null;
          }

          throw error;
        }

        let bindStatus: ClawBondAgentBindStatus;

        try {
          bindStatus = await params.loadBindStatus();
        } catch (error) {
          logWarn(params.ctx, "[clawbond-connector] runtime bind-status check failed", {
            error: stringifyError(error),
            agentId: params.account.agentId
          });
          continue;
        }

        if (bindStatus.bound) {
          continue;
        }

        let profile: ClawBondAgentSelfProfile | null = null;
        try {
          profile = await params.loadProfile();
        } catch (error) {
          logWarn(params.ctx, "[clawbond-connector] failed to refresh agent profile after unbind", {
            error: stringifyError(error),
            agentId: params.account.agentId
          });
        }

        const recoveredAccount = createPendingBindingAccount(params.account, profile);
        await persistRuntimeCredentials(params.store, recoveredAccount);

        setAccountStatus(params.ctx, recoveredAccount, {
          phase: "waiting_for_bind",
          busy: true,
          connected: false,
          bindingStatus: "pending",
          agentId: recoveredAccount.agentId,
          agentName: recoveredAccount.agentName,
          bindCode: recoveredAccount.bindCode || undefined,
          inviteUrl:
            buildInviteUrl(
              params.bootstrapClient,
              recoveredAccount.bindCode,
              recoveredAccount.inviteWebBaseUrl
            ) || undefined,
          message: "ClawBond binding was removed; waiting for the human to bind again"
        });

        logWarn(params.ctx, "[clawbond-connector] binding was removed during runtime", {
          agentId: recoveredAccount.agentId
        });

        return recoveredAccount;
      }
    })(),
    stop: () => {
      stopController.abort();
    }
  };
}

function canRefreshRuntimeToken(account: ClawBondAccount): boolean {
  return Boolean(account.agentId.trim() && account.secretKey.trim());
}

function shouldRetryWithTokenRefresh(account: ClawBondAccount, error: unknown): boolean {
  return canRefreshRuntimeToken(account) && /\b401\b/.test(stringifyError(error));
}

function applyRuntimeToken(account: ClawBondAccount, accessToken: string) {
  const previousRuntimeToken = account.runtimeToken.trim();
  const hasCustomNotificationToken =
    account.notificationAuthToken.trim() &&
    account.notificationAuthToken.trim() !== previousRuntimeToken;
  const nextRuntimeToken = accessToken.trim();

  account.runtimeToken = nextRuntimeToken;

  if (!hasCustomNotificationToken) {
    account.notificationAuthToken = nextRuntimeToken;
  }
}

async function persistRuntimeCredentials(store: CredentialStore, account: ClawBondAccount) {
  const state = createBootstrapStateFromAccount(account);

  if (!state.accessToken || !state.agentId || !state.agentName || !state.secretKey) {
    return;
  }

  await saveBootstrapCredentials(store, account, state);
}

function createBootstrapStateFromAccount(account: ClawBondAccount): BootstrapState {
  return {
    accessToken: account.runtimeToken.trim(),
    agentId: account.agentId.trim(),
    agentName: account.agentName.trim(),
    secretKey: account.secretKey.trim(),
    bindCode: account.bindCode.trim(),
    ownerUserId: account.ownerUserId.trim() || undefined,
    bindingStatus: account.bindingStatus === "bound" ? "bound" : "pending"
  };
}

function createPendingBindingAccount(
  account: ClawBondAccount,
  profile: ClawBondAgentSelfProfile | null
): ClawBondAccount {
  return {
    ...account,
    agentId: profile?.id?.trim() || account.agentId,
    agentName: profile?.name?.trim() || account.agentName,
    bindCode: profile?.bindCode?.trim() || account.bindCode,
    ownerUserId: "",
    bindingStatus: "pending"
  };
}

async function dispatchPlatformInvoke(
  ctx: StartAccountContext,
  account: ClawBondAccount,
  message: ClawBondInvokeMessage,
  resolvePeerLabel?: (message: ClawBondInvokeMessage) => Promise<string | null>
) {
  logInfo(ctx, "[clawbond-connector] inbound invoke", {
    agentId: account.agentId,
    requestId: message.requestId,
    sourceAgentId: message.sourceAgentId,
    conversationId: message.conversationId,
    sessionKey: message.sessionKey,
    messageKind: message.structuredEnvelope?.kind ?? "message",
    deliveryPath: resolveDeliveryPath(message)
  });

  const peerLabel = await resolveDisplayPeerLabel(message, resolvePeerLabel);
  const peer = describeActivityPeer(message, peerLabel);
  const sessionKey = MAIN_SESSION_KEY;
  const inboxStore = new ClawBondInboxStore(account.stateRoot);
  const sourceKind = message.sourceKind || "message";
  const deliveryPath = resolveDeliveryPath(message);
  const traceId = buildPendingTraceId(message);
  const queued = await inboxStore.enqueue(account.accountId, {
    fingerprint: buildPendingInboxFingerprint(message, traceId),
    traceId,
    sourceKind,
    peerId: peer.peerId,
    peerLabel: peer.peerLabel,
    summary: `Pending ${describeSourceKind(message)} from ${peer.peerLabel}`,
    content: message.rawPrompt ?? message.prompt,
    receivedAt: message.timestamp,
    deliveryPath,
    requestId: message.requestId,
    conversationId: message.conversationId,
    notificationId: message.notificationId,
    requestKey: resolveRequestKey(message)
  });
  const effectiveTraceId = queued.item.traceId;

  await recordClawBondActivity(ctx, account, {
    agentId: account.agentId,
    sessionKey,
    itemId: queued.item.id,
    traceId: effectiveTraceId,
    requestId: message.requestId,
    conversationId: message.conversationId,
    peerId: peer.peerId,
    peerLabel: peer.peerLabel,
    deliveryPath,
    sourceKind,
    event: "inbound_received",
    summary: `Received ${describeSourceKind(message)} from ${peer.peerLabel}`,
    preview: truncateActivityPreview(message.rawPrompt ?? message.prompt)
  });

  if (queued.created || queued.merged) {
    await recordClawBondActivity(ctx, account, {
      agentId: account.agentId,
      sessionKey,
      itemId: queued.item.id,
      traceId: effectiveTraceId,
      requestId: message.requestId,
      conversationId: message.conversationId,
      peerId: peer.peerId,
      peerLabel: peer.peerLabel,
      deliveryPath,
      sourceKind,
      event: "main_inbox_queued",
      summary: queued.merged
        ? `Merged ${describeSourceKind(message)} from ${peer.peerLabel} into existing pending main-session item`
        : `Queued ${describeSourceKind(message)} from ${peer.peerLabel} for main-session handling`,
      preview: truncateActivityPreview(message.rawPrompt ?? message.prompt)
    });

    const skipDmWakeByCooldown = shouldSkipMergedDmWakeByCooldown(queued, sourceKind);
    if (skipDmWakeByCooldown) {
      logInfo(ctx, "[clawbond-connector] skipped merged DM wake due to cooldown", {
        accountId: account.accountId,
        itemId: queued.item.id,
        peerId: queued.item.peerId,
        conversationId: queued.item.conversationId,
        wakeRequestedAt: queued.item.wakeRequestedAt,
        wakeCount: queued.item.wakeCount
      });
    } else {
      scheduleMainSessionWake(ctx, account, [queued.item.id]);
    }
  } else {
    logInfo(ctx, "[clawbond-connector] skipped duplicate pending inbox item", {
      accountId: account.accountId,
      peerId: peer.peerId,
      requestId: message.requestId,
      sourceKind
    });
  }

  setAccountStatus(ctx, account, {
    connected: true,
    lastInboundAt: Date.now(),
    lastError: null
  });
}

function shouldSkipMergedDmWakeByCooldown(
  queued: { created: boolean; merged: boolean; item: { wakeRequestedAt: string | null; wakeCount: number } },
  sourceKind: ClawBondInvokeMessage["sourceKind"]
): boolean {
  if (sourceKind !== "message" || !queued.merged) {
    return false;
  }

  if ((queued.item.wakeCount ?? 0) <= 0) {
    return false;
  }

  const lastWakeAt = Date.parse(queued.item.wakeRequestedAt ?? "");
  if (Number.isNaN(lastWakeAt)) {
    return false;
  }

  return Date.now() - lastWakeAt < DM_MERGED_WAKE_COOLDOWN_MS;
}

function markOutboundSuccess(ctx: StartAccountContext, account: ClawBondAccount) {
  setAccountStatus(ctx, account, {
    connected: true,
    lastOutboundAt: Date.now(),
    lastError: null
  });
}

function buildPendingTraceId(message: ClawBondInvokeMessage): string {
  const explicit = message.traceId?.trim();
  if (explicit) {
    return explicit;
  }

  if (message.notificationId?.trim()) {
    return `notification:${message.notificationId.trim()}`;
  }

  const requestKey = resolveRequestKey(message);
  if (requestKey) {
    return `request:${requestKey}`;
  }

  const hash = createHash("sha1");
  hash.update(message.sourceKind || "message");
  hash.update("\n");
  hash.update(message.sourceAgentId.trim());
  hash.update("\n");
  hash.update(message.conversationId.trim());
  hash.update("\n");
  hash.update(message.timestamp.trim());
  hash.update("\n");
  hash.update(message.rawPrompt ?? message.prompt);
  return `message:${hash.digest("hex")}`;
}

function buildPendingInboxFingerprint(message: ClawBondInvokeMessage, traceId: string): string {
  if (traceId.trim()) {
    return traceId.trim();
  }

  return buildPendingTraceId(message);
}

function resolveRequestKey(message: ClawBondInvokeMessage): string {
  const taskId = message.structuredEnvelope?.taskId?.trim();
  if (taskId) {
    return taskId;
  }

  if (message.sourceKind === "connection_request" || message.sourceKind === "connection_request_response") {
    return message.requestId.trim();
  }

  return "";
}

function scheduleMainSessionWake(
  ctx: StartAccountContext,
  account: ClawBondAccount,
  itemIds: string[]
) {
  const accountId = account.accountId;
  let pendingIds = pendingMainWakeItemIds.get(accountId);
  if (!pendingIds) {
    pendingIds = new Set<string>();
    pendingMainWakeItemIds.set(accountId, pendingIds);
  }

  for (const itemId of itemIds) {
    if (itemId.trim()) {
      pendingIds.add(itemId.trim());
    }
  }

  const existingTimer = pendingMainWakeTimers.get(accountId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  pendingMainWakeTimers.set(
    accountId,
    setTimeout(() => {
      pendingMainWakeTimers.delete(accountId);
      const nextPendingIds = Array.from(pendingMainWakeItemIds.get(accountId) ?? []);
      pendingMainWakeItemIds.delete(accountId);
      void triggerMainSessionWake(ctx, account, nextPendingIds);
    }, MAIN_WAKE_DEBOUNCE_MS)
  );
}

function clearScheduledMainSessionWork(accountId: string) {
  const wakeTimer = pendingMainWakeTimers.get(accountId);
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    pendingMainWakeTimers.delete(accountId);
  }
  pendingMainWakeItemIds.delete(accountId);
  clearClawBondMainWakeQueue(accountId);
}

async function triggerMainSessionWake(
  ctx: StartAccountContext,
  account: ClawBondAccount,
  itemIds: string[]
) {
  if (itemIds.length === 0) {
    return;
  }

  const inboxStore = new ClawBondInboxStore(account.stateRoot);
  await inboxStore.markWakeRequested(account.accountId, itemIds);
  const wakeItems = inboxStore.listPendingByIdsSync(account.accountId, itemIds);
  const pendingCount = inboxStore.countPendingSync(account.accountId);
  if (pendingCount === 0 || wakeItems.length === 0) {
    return;
  }

  enqueueClawBondMainWake(
    account.accountId,
    wakeItems.map((item) => item.id)
  );

  if (account.visibleMainSessionNotes) {
    queueMainSessionVisibleNote(buildMainWakeVisibleNote(wakeItems), {
      label: "ClawBond",
      onError: (error) => {
        logWarn(ctx, "[clawbond-connector] failed to inject main-session processing note", {
          error: stringifyError(error)
        });
      }
    });
  }

  const dmItems = wakeItems.filter((item) => item.sourceKind === "message");
  const nonDmItems = wakeItems.filter((item) => item.sourceKind !== "message");

  if (dmItems.length > 0) {
    const chatSendText = buildMainRealtimeChatSendText(dmItems);
    queueMainSessionChatSend(chatSendText, {
      onError: (error) => {
        void recordMainWakeActivity(ctx, account, dmItems, "main_run_failed", {
          summary: "Failed to send direct main-session ClawBond DM handoff",
          error: stringifyError(error)
        });
        logWarn(ctx, "[clawbond-connector] failed to send direct main-session DM handoff", {
          error: stringifyError(error)
        });
      }
    });

    await recordMainWakeActivity(ctx, account, dmItems, "main_run_requested", {
      summary: "Queued direct main-session ClawBond DM handoff",
      preview: truncateActivityPreview(chatSendText)
    });
  }

  if (nonDmItems.length > 0) {
    const wakeEventText = buildMainRealtimeWakeEventText(nonDmItems);

    queueMainSessionWakeEvent(wakeEventText, {
      onError: (error) => {
        void recordMainWakeActivity(ctx, account, nonDmItems, "main_run_failed", {
          summary: "Failed to request immediate main-session ClawBond wake",
          error: stringifyError(error)
        });
        logWarn(ctx, "[clawbond-connector] failed to request main-session wake event", {
          error: stringifyError(error)
        });
      }
    });

    await recordMainWakeActivity(ctx, account, nonDmItems, "main_run_requested", {
      summary: "Queued immediate main-session ClawBond wake",
      preview: truncateActivityPreview(wakeEventText)
    });
  }
}

function buildMainRealtimeWakeEventText(
  items: Array<{
    id: string;
    sourceKind: ClawBondInvokeMessage["sourceKind"];
    peerId: string;
    peerLabel: string;
    conversationId?: string;
    notificationId?: string;
    requestKey?: string;
    content: string;
    summary: string;
  }>
): string {
  const marker = CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE;
  if (items.length === 0) {
    return marker;
  }

  const summaries = items
    .slice(0, 3)
    .map((item) => `${describePendingSourceKind(item.sourceKind)} from ${item.peerLabel}`)
    .join("; ");

  return `${marker} ${summaries}`;
}

function buildMainRealtimeChatSendText(
  items: Array<{
    id: string;
    sourceKind: ClawBondInvokeMessage["sourceKind"];
    peerId: string;
    peerLabel: string;
    conversationId?: string;
    notificationId?: string;
    requestKey?: string;
    content: string;
    summary: string;
  }>
): string {
  const base = buildMainRealtimeWakeEventText(items);
  return [
    base,
    "This is not a heartbeat poll. Do not reply with HEARTBEAT_OK.",
    "Handle the attached ClawBond pending item in this main session now.",
    "If a platform-side reply is needed, use the matching ClawBond tool in this same turn instead of replying only in local chat."
  ].join(" ");
}

function describePendingSourceKind(sourceKind: ClawBondInvokeMessage["sourceKind"]): string {
  switch (sourceKind) {
    case "notification":
      return "notification";
    case "connection_request":
      return "connection request";
    case "connection_request_response":
      return "connection request response";
    default:
      return "DM";
  }
}

function buildMainWakeVisibleNote(
  items: Array<{
    id: string;
    sourceKind: ClawBondInvokeMessage["sourceKind"];
    peerId: string;
    peerLabel: string;
    conversationId?: string;
    notificationId?: string;
    requestKey?: string;
    content: string;
    summary: string;
  }>
): string {
  if (items.length !== 1) {
    return `Received ${items.length} new ClawBond items. Agent notified. / 收到 ${items.length} 条新的 ClawBond 消息，已通知 agent。`;
  }

  const [item] = items;
  switch (item.sourceKind) {
    case "notification":
      return `New notification from ${item.peerLabel}. Agent notified. / 收到来自 ${item.peerLabel} 的新通知，已通知 agent。`;
    case "connection_request":
    case "connection_request_response":
      return `Connection request update from ${item.peerLabel}. Agent notified. / 收到来自 ${item.peerLabel} 的连接请求更新，已通知 agent。`;
    case "message":
    default:
      return `New DM from ${item.peerLabel}. Agent notified. / 收到来自 ${item.peerLabel} 的新私信，已通知 agent。`;
  }
}

function resolveOutboundAccount(cfg: OpenClawConfig, accountId?: string | null): ClawBondAccount {
  return resolveAccount(cfg, resolveConfiguredAccountId(cfg, accountId));
}

function requirePlatformClient(accountId: string): PlatformClient {
  const client = runtimeClients.get(accountId);

  if (!client) {
    throw new Error(`No active PlatformClient for account ${accountId}`);
  }

  return client;
}

function normalizeTarget(target: string): string {
  return target.replace(/^clawbond:/i, "").trim();
}

function resolveConfiguredAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  if (accountId?.trim()) {
    return accountId;
  }

  return listAccountIds(cfg)[0] ?? "default";
}

function buildDeliveryResult(to: string) {
  return {
    channel: CHANNEL_ID,
    messageId: `clawbond-${Date.now()}`,
    conversationId: to,
    meta: {
      target: normalizeTarget(to)
    }
  } as const;
}

function setAccountStatus(
  ctx: StartAccountContext,
  account: ClawBondAccount,
  patch: Partial<ClawBondStatusSnapshot>
) {
  const current = ctx.getStatus() as ClawBondStatusSnapshot;
  const bindCode = typeof patch.bindCode === "string" ? patch.bindCode : account.bindCode;
  const inviteUrl =
    typeof patch.inviteUrl === "string"
      ? patch.inviteUrl
      : buildInviteUrl(
          new BootstrapClient(account.apiBaseUrl || account.serverUrl),
          bindCode,
          account.inviteWebBaseUrl
        ) || undefined;
  const bindingStatus = normalizeBindingStatus(patch.bindingStatus) ?? account.bindingStatus;

  const next: ClawBondStatusSnapshot = {
    ...current,
    accountId: account.accountId,
    channel: CHANNEL_ID,
    configured: Boolean(account.configured),
    enabled: account.enabled,
    agentId: (patch.agentId ?? account.agentId) || undefined,
    agentName: (patch.agentName ?? account.agentName) || undefined,
    bindingStatus,
    bindCode: bindCode || undefined,
    inviteUrl,
    ...patch,
    linked: bindingStatus === "bound"
  };

  if (next.busy === true && (patch.busy === true || typeof next.lastRunActivityAt !== "number")) {
    next.lastRunActivityAt = Date.now();
  }

  ctx.setStatus(next);
}

function buildInviteUrl(
  bootstrapClient: BootstrapClient,
  bindCode: string,
  inviteWebBaseUrl: string
): string {
  return bootstrapClient.buildInviteUrl(bindCode, inviteWebBaseUrl);
}

function createDefaultStatusRuntime(accountId: string): ClawBondStatusSnapshot {
  return {
    accountId,
    running: false,
    connected: false,
    busy: false,
    reconnectAttempts: 0,
    restartPending: false,
    linked: false,
    bindingStatus: "unregistered",
    phase: "idle"
  };
}

function buildChannelSummary(snapshot: ClawBondStatusSnapshot): ChannelAccountSnapshot {
  return {
    accountId: snapshot.accountId,
    configured: Boolean(snapshot.configured),
    linked: Boolean(snapshot.linked),
    running: Boolean(snapshot.running),
    connected: Boolean(snapshot.connected),
    phase: snapshot.phase ?? null,
    message: snapshot.message ?? null,
    bindingStatus: snapshot.bindingStatus ?? null,
    bindCode: snapshot.bindCode ?? null,
    inviteUrl: snapshot.inviteUrl ?? null,
    agentId: snapshot.agentId ?? null,
    agentName: snapshot.agentName ?? null,
    lastError: snapshot.lastError ?? null,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    reconnectAttempts: snapshot.reconnectAttempts ?? 0,
    restartPending: Boolean(snapshot.restartPending)
  };
}

function buildAccountSnapshot(
  account: ClawBondAccount,
  runtime?: ChannelAccountSnapshot
): ChannelAccountSnapshot {
  const live = (runtime ?? {}) as ClawBondStatusSnapshot;
  const bindingStatus = normalizeBindingStatus(live.bindingStatus) ?? account.bindingStatus;
  const bindCode =
    typeof live.bindCode === "string" ? live.bindCode : account.bindCode;
  const inviteUrl =
    typeof live.inviteUrl === "string"
      ? live.inviteUrl
      : buildInviteUrl(
          new BootstrapClient(account.apiBaseUrl || account.serverUrl),
          bindCode,
          account.inviteWebBaseUrl
        ) || undefined;

  return {
    accountId: account.accountId,
    name: account.agentName || PLATFORM_LABEL,
    enabled: account.enabled,
    configured: Boolean(account.configured),
    linked: bindingStatus === "bound",
    baseUrl: account.serverUrl || undefined,
    agentId: (typeof live.agentId === "string" ? live.agentId : account.agentId) || undefined,
    agentName: (typeof live.agentName === "string" ? live.agentName : account.agentName) || undefined,
    bindingStatus,
    bindCode: bindCode || undefined,
    inviteUrl,
    running: live.running ?? false,
    connected: live.connected ?? false,
    busy: live.busy ?? false,
    phase: live.phase ?? null,
    message: live.message ?? null,
    reconnectAttempts: live.reconnectAttempts ?? 0,
    restartPending: live.restartPending ?? false,
    lastStartAt: live.lastStartAt ?? null,
    lastStopAt: live.lastStopAt ?? null,
    lastInboundAt: live.lastInboundAt ?? null,
    lastOutboundAt: live.lastOutboundAt ?? null,
    lastRunActivityAt: live.lastRunActivityAt ?? null,
    lastError: live.lastError ?? null
  };
}

async function recordClawBondActivity(
  ctx: StartAccountContext,
  account: ClawBondAccount,
  entry: Parameters<ClawBondActivityStore["append"]>[1]
) {
  try {
    const store = new ClawBondActivityStore(account.stateRoot);
    await store.append(account.accountId, entry);
  } catch (error) {
    logWarn(ctx, "[clawbond-connector] failed to persist activity entry", {
      error: stringifyError(error),
      event: entry.event,
      sessionKey: entry.sessionKey
    });
  }
}

async function recordMainWakeActivity(
  ctx: StartAccountContext,
  account: ClawBondAccount,
  items: Array<{
    id: string;
    traceId: string;
    sourceKind: ClawBondInvokeMessage["sourceKind"];
    peerId: string;
    peerLabel: string;
    conversationId?: string;
    deliveryPath?: ClawBondInvokeMessage["deliveryPath"];
    summary: string;
    content: string;
  }>,
  event: "main_run_requested" | "main_run_failed",
  details: { summary: string; preview?: string; error?: string }
) {
  for (const item of items) {
    await recordClawBondActivity(ctx, account, {
      agentId: account.agentId,
      sessionKey: MAIN_SESSION_KEY,
      itemId: item.id,
      traceId: item.traceId,
      conversationId: item.conversationId,
      peerId: item.peerId,
      peerLabel: item.peerLabel,
      deliveryPath: item.deliveryPath,
      sourceKind: item.sourceKind || "message",
      event,
      summary: `${details.summary} for ${describePendingSourceKind(item.sourceKind)} from ${item.peerLabel}`,
      preview: details.preview,
      error: details.error
    });
  }
}

async function syncRuntimeDmCatchUp(params: {
  ctx: StartAccountContext;
  account: ClawBondAccount;
  store: CredentialStore;
  pollMessages: (after: string | undefined, limit: number) => Promise<{
    data: unknown[];
    pagination?: unknown;
  }>;
  resolvePeerLabel: (message: ClawBondInvokeMessage) => Promise<string | null>;
  reason: "initial_start" | "reconnect";
}) {
  const accountId = params.account.accountId;
  const syncState = params.store.loadSyncStateSync(accountId);
  let cursor = syncState.last_seen_dm_cursor ?? undefined;
  let processed = 0;
  let pageCount = 0;

  while (pageCount < 5) {
    throwIfAborted(params.ctx.abortSignal);

    const result = await params.pollMessages(cursor, 20);
    const messages = normalizePolledDmMessages(result.data);
    const nextCursor = readNextCursor(result.pagination);

    for (const message of messages) {
      await dispatchPlatformInvoke(
        params.ctx,
        params.account,
        buildInvokeMessageFromPolledDm(params.account, message),
        params.resolvePeerLabel
      );
      processed += 1;
    }

    if (nextCursor && nextCursor !== syncState.last_seen_dm_cursor) {
      syncState.last_seen_dm_cursor = nextCursor;
      await params.store.saveSyncState(accountId, syncState);
    }

    if (messages.length === 0 || !nextCursor || nextCursor === cursor) {
      break;
    }

    cursor = nextCursor;
    pageCount += 1;
  }

  if (processed > 0) {
    logInfo(params.ctx, "[clawbond-connector] runtime DM catch-up completed", {
      accountId,
      reason: params.reason,
      processed
    });
  }
}

function resolveDeliveryPath(message: ClawBondInvokeMessage): ClawBondInvokeMessage["deliveryPath"] {
  if (message.deliveryPath) {
    return message.deliveryPath;
  }

  return "platform_realtime";
}

function describeActivityPeer(
  message: ClawBondInvokeMessage,
  preferredLabel?: string | null
): { peerId: string; peerLabel: string } {
  const peerId = message.sourceAgentId.trim() || "unknown";
  const normalizedPreferredLabel = preferredLabel?.trim();
  if (normalizedPreferredLabel) {
    return {
      peerId,
      peerLabel: normalizedPreferredLabel
    };
  }

  if (message.sourceKind === "notification") {
    const parts = peerId.split(":");
    if (parts.length >= 3) {
      return {
        peerId,
        peerLabel: `${parts[1]}:${parts.slice(2).join(":")}`
      };
    }
  }

  return {
    peerId,
    peerLabel: peerId
  };
}

async function resolveDisplayPeerLabel(
  message: ClawBondInvokeMessage,
  resolvePeerLabel?: (message: ClawBondInvokeMessage) => Promise<string | null>
): Promise<string | null> {
  if (!resolvePeerLabel) {
    return null;
  }

  try {
    const resolved = await resolvePeerLabel(message);
    return resolved?.trim() || null;
  } catch {
    return null;
  }
}

async function resolveRealtimePeerLabel(params: {
  api: ClawBondServerApiClient;
  accessToken: string;
  message: ClawBondInvokeMessage;
  cache: Map<string, string>;
}): Promise<string | null> {
  const peerId = params.message.sourceAgentId.trim();
  if (!peerId) {
    return null;
  }

  const cached = params.cache.get(peerId);
  if (cached) {
    return cached;
  }

  const conversationId = params.message.conversationId?.trim();
  if (!conversationId || (params.message.sourceKind ?? "message") !== "message") {
    return null;
  }

  const response = await params.api.listConversationMessages(
    params.accessToken,
    conversationId,
    10
  );

  const rows = Array.isArray(response.data) ? response.data : [];
  const exactMatch = rows.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }

    const candidate = entry as Record<string, unknown>;
    const senderId = readRecordString(candidate, "sender_id");
    const content = readRecordString(candidate, "content");
    return senderId === peerId && content === (params.message.rawPrompt ?? params.message.prompt);
  });
  const latestFromPeer = rows.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }

    return readRecordString(entry as Record<string, unknown>, "sender_id") === peerId;
  });

  const matched =
    (exactMatch && typeof exactMatch === "object" && !Array.isArray(exactMatch)
      ? (exactMatch as Record<string, unknown>)
      : null) ??
    (latestFromPeer && typeof latestFromPeer === "object" && !Array.isArray(latestFromPeer)
      ? (latestFromPeer as Record<string, unknown>)
      : null);

  const label =
    readRecordString(matched, "sender_name") ||
    readRecordString(matched, "sender_nickname") ||
    null;

  if (label) {
    params.cache.set(peerId, label);
  }

  return label;
}

function readRecordString(
  value: Record<string, unknown> | null | undefined,
  key: string
): string {
  if (!value) {
    return "";
  }

  const candidate = value[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function describeSourceKind(message: ClawBondInvokeMessage): string {
  switch (message.sourceKind) {
    case "notification":
      return "notification";
    case "connection_request":
      return "connection request";
    case "connection_request_response":
      return "connection request response";
    default:
      return "DM";
  }
}

interface PolledDmMessage {
  id: string;
  senderId: string;
  conversationId: string;
  content: string;
  createdAt: string;
}

function normalizePolledDmMessages(items: unknown): PolledDmMessage[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const id = readRecordString(candidate, "id");
    const senderId =
      readRecordString(candidate, "sender_id") || readRecordString(candidate, "senderId");
    const conversationId =
      readRecordString(candidate, "conversation_id") || readRecordString(candidate, "conversationId");
    const content = readRecordString(candidate, "content");
    const createdAt =
      readRecordString(candidate, "created_at") || readRecordString(candidate, "createdAt");

    if (!id || !senderId || !content || !createdAt) {
      return [];
    }

    return [
      {
        id,
        senderId,
        conversationId,
        content,
        createdAt
      }
    ];
  });
}

function buildInvokeMessageFromPolledDm(
  account: ClawBondAccount,
  message: PolledDmMessage
): ClawBondInvokeMessage {
  const incoming = resolveStructuredIncomingPrompt(account, {
    event: "message",
    from_agent_id: message.senderId,
    conversation_id: message.conversationId || undefined,
    content: message.content,
    sender_type: "agent",
    timestamp: message.createdAt
  });

  return {
    type: "invoke",
    requestId: `poll-${message.id}`,
    conversationId:
      message.conversationId || buildPolledConversationId(account.agentId, message.senderId),
    timestamp: message.createdAt,
    sourceAgentId: message.senderId,
    sourceKind: "message",
    prompt: incoming.prompt,
    rawPrompt: message.content,
    structuredEnvelope: incoming.structuredEnvelope,
    deliveryPath: "message_polling"
  };
}

function buildPolledConversationId(agentA: string, agentB: string): string {
  return [agentA, agentB].sort().join(":");
}

function readNextCursor(pagination: unknown): string | undefined {
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
    return undefined;
  }

  const candidate = pagination as Record<string, unknown>;
  const nextCursor = candidate.next_cursor ?? candidate.nextCursor;
  return typeof nextCursor === "string" && nextCursor.trim() ? nextCursor.trim() : undefined;
}

function truncateActivityPreview(value: string, limit = 88): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }

  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}...` : normalized;
}

function normalizeBindingStatus(value: unknown): ClawBondBindingStatus | undefined {
  return value === "unregistered" || value === "pending" || value === "bound" ? value : undefined;
}

function stringifyError(error: unknown): string {
  return sanitizeLogString(error instanceof Error ? error.message : String(error));
}

function logInfo(
  ctx: StartAccountContext,
  message: string,
  extra?: unknown
) {
  const safeMessage = sanitizeLogString(message);
  ctx.log?.info?.(formatLogMessage(safeMessage, extra));
  getClawBondRuntime().logger?.info?.(safeMessage, toLogMeta(extra));
}

function logWarn(
  ctx: StartAccountContext,
  message: string,
  extra?: unknown
) {
  const safeMessage = sanitizeLogString(message);
  ctx.log?.warn?.(formatLogMessage(safeMessage, extra));
  getClawBondRuntime().logger?.warn?.(safeMessage, toLogMeta(extra));
}

function logError(
  ctx: StartAccountContext,
  message: string,
  extra?: unknown
) {
  const safeMessage = sanitizeLogString(message);
  ctx.log?.error?.(formatLogMessage(safeMessage, extra));
  getClawBondRuntime().logger?.error?.(safeMessage, toLogMeta(extra));
}

function formatLogMessage(message: string, extra?: unknown): string {
  const safeMessage = sanitizeLogString(message);

  if (extra === undefined) {
    return safeMessage;
  }

  const safeExtra = sanitizeLogValue(extra);

  try {
    return `${safeMessage} ${JSON.stringify(safeExtra)}`;
  } catch {
    return `${safeMessage} ${String(safeExtra)}`;
  }
}

function toLogMeta(extra?: unknown): Record<string, unknown> | undefined {
  const sanitized = sanitizeLogValue(extra);

  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return undefined;
  }

  return sanitized as Record<string, unknown>;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  const onAbort = () => {
    cleanup();
    controller.abort();
  };

  const cleanup = () => {
    for (const signal of signals) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

function waitUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function sleepWithAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError());
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
