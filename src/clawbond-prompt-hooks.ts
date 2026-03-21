import type {
  OpenClawPluginApi,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult
} from "openclaw/plugin-sdk";

import {
  buildPendingMainInboxAgentContext,
  buildClawBondPolicyContext,
  getClawBondAccountStatusSnapshot,
  loadClawBondPendingMainInboxSnapshot
} from "./clawbond-assist.ts";
import { CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE } from "./openclaw-cli.ts";

export function registerClawBondPromptHooks(api: OpenClawPluginApi) {
  api.on("before_prompt_build", createClawBondBeforePromptBuildHandler(api), { priority: 20 });
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
      const pendingMainInbox = loadClawBondPendingMainInboxSnapshot(api.config);
      const pendingInjection = buildPendingMainInboxAgentContext(pendingMainInbox);
      if (pendingInjection) {
        prependSystemBlocks.push(pendingInjection);
      }
    }

    return {
      appendSystemContext,
      prependSystemContext: joinPrependBlocks(prependSystemBlocks)
    };
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

  return candidates.some(
    (value) => value === "main" || value === "agent:main:main" || value.endsWith(":main")
  );
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
