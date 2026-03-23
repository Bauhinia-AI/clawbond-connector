import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookSessionContext,
  PluginHookSessionStartEvent
} from "openclaw/plugin-sdk";

import {
  buildPendingMainInboxAgentContext,
  buildClawBondPolicyContext,
  getClawBondAccountStatusSnapshot,
  loadClawBondPendingMainInboxSnapshot
} from "./clawbond-assist.ts";
import { ClawBondActivityStore } from "./activity-store.ts";
import { buildClawBondWelcomeMessage } from "./clawbond-onboarding.ts";
import {
  CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE,
  queueMainSessionVisibleNote
} from "./openclaw-cli.ts";

const welcomedMainSessions = new Set<string>();

export function registerClawBondPromptHooks(api: OpenClawPluginApi) {
  api.on("before_prompt_build", createClawBondBeforePromptBuildHandler(api), { priority: 20 });
  api.on("session_start", createClawBondSessionStartHandler(api), { priority: 20 });
}

export function createClawBondBeforePromptBuildHandler(api: Pick<OpenClawPluginApi, "config"> & {
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
}) {
  return async function onBeforePromptBuild(
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext
  ): Promise<PluginHookBeforePromptBuildResult | void> {
    void event;

    const snapshot = getClawBondAccountStatusSnapshot(api.config);
    if (!snapshot?.configured) {
      return undefined;
    }

    const appendSystemContext = buildClawBondPolicyContext();
    const prependSystemBlocks: string[] = [];

    if (shouldInjectPendingMainInboxAgentContext(event, ctx)) {
      const pendingMainInbox = loadClawBondPendingMainInboxSnapshot(api.config, snapshot.accountId, 20);
      const pendingInjection = buildPendingMainInboxAgentContext(pendingMainInbox);
      if (pendingInjection) {
        prependSystemBlocks.push(pendingInjection);
        await recordPromptInjectionActivity(api, snapshot.accountId, snapshot.agentId, ctx, pendingMainInbox);
      }
    }

    return {
      appendSystemContext,
      prependSystemContext: joinPrependBlocks(prependSystemBlocks)
    };
  };
}

async function recordPromptInjectionActivity(
  api: Pick<OpenClawPluginApi, "config"> & {
    logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
  },
  accountId: string,
  agentId: string,
  ctx: PluginHookAgentContext,
  snapshot: ReturnType<typeof loadClawBondPendingMainInboxSnapshot>
) {
  if (!snapshot || snapshot.items.length === 0) {
    return;
  }

  try {
    const accountSnapshot = getClawBondAccountStatusSnapshot(api.config, accountId);
    const stateRoot = accountSnapshot?.stateRoot;
    if (!stateRoot) {
      return;
    }

    const store = new ClawBondActivityStore(stateRoot);
    for (const item of snapshot.items) {
      await store.append(accountId, {
        agentId,
        sessionKey: ctx.sessionKey?.trim() || ctx.sessionId?.trim() || "agent:main:main",
        itemId: item.id,
        traceId: item.traceId,
        conversationId: item.conversationId,
        peerId: item.peerId,
        peerLabel: item.peerLabel,
        deliveryPath: item.deliveryPath,
        sourceKind: item.sourceKind,
        event: "main_prompt_injected",
        summary: `Injected pending ${formatPromptItemKind(item.sourceKind)} from ${item.peerLabel} into the main-session prompt`,
        preview: truncatePromptHookPreview(item.content)
      });
    }
  } catch (error) {
    api.logger?.warn?.("failed to persist ClawBond prompt injection activity", {
      error: error instanceof Error ? error.message : String(error),
      accountId
    });
  }
}

function formatPromptItemKind(sourceKind: NonNullable<ReturnType<typeof loadClawBondPendingMainInboxSnapshot>>["items"][number]["sourceKind"]): string {
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

function truncatePromptHookPreview(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

export function createClawBondSessionStartHandler(api: Pick<OpenClawPluginApi, "config" | "runtime">) {
  return async function onSessionStart(
    event: PluginHookSessionStartEvent,
    ctx: PluginHookSessionContext
  ): Promise<void> {
    const sessionRef = normalizeSessionRef(event.sessionKey ?? ctx.sessionKey ?? event.sessionId);
    if (!sessionRef || !isMainSessionRef(sessionRef)) {
      return;
    }

    if (welcomedMainSessions.has(sessionRef)) {
      return;
    }

    const cfg = api.runtime.config?.loadConfig?.() ?? api.config;
    const welcomeMessage = buildClawBondWelcomeMessage(cfg);
    if (!welcomeMessage) {
      return;
    }

    welcomedMainSessions.add(sessionRef);
    queueMainSessionVisibleNote(welcomeMessage, {
      label: "ClawBond"
    });
  };
}

function shouldInjectPendingMainInboxAgentContext(
  event: PluginHookBeforePromptBuildEvent,
  ctx: PluginHookAgentContext
): boolean {
  if (ctx.channelId === "clawbond") {
    return false;
  }

  if (!isMainSession(ctx)) {
    return false;
  }

  if (isClawBondWakeEvent(event)) {
    return true;
  }

  if (ctx.trigger === "system") {
    return true;
  }

  return false;
}

function isMainSession(ctx: PluginHookAgentContext): boolean {
  const candidates = [ctx.sessionKey, ctx.sessionId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  if (candidates.length === 0) {
    return false;
  }

  return candidates.some((value) => isMainSessionRef(value));
}

function isDirectClawBondActivation(event: PluginHookBeforePromptBuildEvent): boolean {
  if (event.prompt.includes(CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE)) {
    return true;
  }

  return messageContainsActivationMarker(event.messages.at(-1));
}

function isClawBondWakeEvent(event: PluginHookBeforePromptBuildEvent): boolean {
  return isDirectClawBondActivation(event);
}

function messageContainsActivationMarker(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE);
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.includes(CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE);
  }
  if (typeof record.content === "string") {
    return record.content.includes(CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE);
  }
  if (Array.isArray(record.content)) {
    return record.content.some((entry) => messageContainsActivationMarker(entry));
  }

  return false;
}

function joinPrependBlocks(blocks: string[]): string | undefined {
  const normalized = blocks.filter((entry) => entry.trim());
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.join("\n\n");
}

function normalizeSessionRef(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  return value.trim();
}

function isMainSessionRef(value: string): boolean {
  return value === "main" || value === "agent:main:main" || value.endsWith(":main");
}
