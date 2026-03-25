declare module "openclaw/plugin-sdk" {
  export type OpenClawConfig = {
    channels?: Record<string, unknown>;
    session?: {
      store?: string;
    };
    [key: string]: unknown;
  };

  export type OutboundReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string;
  };

  export type RuntimeLogger = {
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };

  export type ToolTextContent = {
    type: "text";
    text: string;
  };

  export type ToolImageContent = {
    type: "image";
    data: string;
    mimeType: string;
  };

  export type AgentToolResult<T = unknown> = {
    content: Array<ToolTextContent | ToolImageContent>;
    details: T;
  };

  export type AnyAgentTool = {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    ownerOnly?: boolean;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (partial: AgentToolResult<unknown>) => void
    ) => Promise<AgentToolResult<unknown>>;
  };

  export type OpenClawPluginToolContext = {
    config: OpenClawConfig;
    workspaceDir?: string;
    agentDir?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    messageChannel?: string;
    agentAccountId?: string;
    requesterSenderId?: string;
    senderIsOwner?: boolean;
    sandboxed?: boolean;
  };

  export type OpenClawPluginToolFactory = (
    ctx: OpenClawPluginToolContext
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;

  export type PluginCommandContext = {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: OpenClawConfig;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: number;
  };

  export type PluginCommandResult = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    replyToId?: string | null;
  };

  export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
  };

  export type PluginHookBeforePromptBuildEvent = {
    prompt: string;
    messages: unknown[];
  };

  export type PluginHookBeforePromptBuildResult = {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
  };

  export type PluginHookSessionContext = {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
  };

  export type PluginHookSessionStartEvent = {
    sessionId: string;
    sessionKey?: string;
    resumedFrom?: string;
  };

  export type PluginHookSessionEndEvent = {
    sessionId: string;
    sessionKey?: string;
    messageCount: number;
    durationMs?: number;
  };

  export type PluginHookHandlerMap = {
    before_prompt_build: (
      event: PluginHookBeforePromptBuildEvent,
      ctx: PluginHookAgentContext
    ) => Promise<PluginHookBeforePromptBuildResult | void> | PluginHookBeforePromptBuildResult | void;
    session_start: (
      event: PluginHookSessionStartEvent,
      ctx: PluginHookSessionContext
    ) => Promise<void> | void;
    session_end: (
      event: PluginHookSessionEndEvent,
      ctx: PluginHookSessionContext
    ) => Promise<void> | void;
  };

  export type OpenClawPluginCommandDefinition = {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (
      ctx: PluginCommandContext
    ) => PluginCommandResult | Promise<PluginCommandResult>;
  };

  export type PluginRuntime = {
    logger?: RuntimeLogger;
    config?: {
      loadConfig?: () => OpenClawConfig;
      writeConfigFile?: (cfg: OpenClawConfig) => Promise<void>;
    };
    system?: {
      enqueueSystemEvent?: (
        text: string,
        options: { sessionKey: string; contextKey?: string | null }
      ) => boolean;
      requestHeartbeatNow?: (options?: {
        reason?: string;
        coalesceMs?: number;
        agentId?: string;
        sessionKey?: string;
      }) => void;
    };
    channel: {
      routing: {
        resolveAgentRoute: (params: {
          cfg: OpenClawConfig;
          channel: string;
          accountId?: string;
          peer: {
            kind: "direct" | "group" | "thread";
            id: string;
          };
        }) => {
          agentId: string;
          sessionKey: string;
          accountId?: string;
        };
      };
      session: {
        resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
        readSessionUpdatedAt: (params: {
          storePath: string;
          sessionKey: string;
        }) => string | number | undefined;
        recordInboundSession: (params: {
          storePath: string;
          sessionKey: string;
          ctx: Record<string, unknown>;
          onRecordError: (err: unknown) => void;
        }) => Promise<void>;
      };
      reply: {
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => T & Record<string, unknown>;
        dispatchReplyWithBufferedBlockDispatcher: (params: {
          ctx: Record<string, unknown>;
          cfg: OpenClawConfig;
          dispatcherOptions: {
            deliver: (payload: unknown) => Promise<void>;
            onError?: (err: unknown, info: { kind: string }) => void;
          };
          replyOptions?: Record<string, unknown>;
        }) => Promise<unknown>;
        resolveEnvelopeFormatOptions: (cfg: OpenClawConfig) => unknown;
        formatAgentEnvelope: (params: {
          channel: string;
          from: string;
          timestamp?: string | number;
          previousTimestamp?: string | number;
          envelope?: unknown;
          body: string;
        }) => string;
      };
    };
  };

  export type OpenClawPluginApi = {
    id?: string;
    name?: string;
    config: OpenClawConfig;
    runtime: PluginRuntime;
    registerTool: (
      tool: AnyAgentTool | OpenClawPluginToolFactory,
      opts?: { name?: string; names?: string[]; optional?: boolean }
    ) => void;
    registerChannel: (params: { plugin: ChannelPlugin<any> }) => void;
    registerCommand: (command: OpenClawPluginCommandDefinition) => void;
    on: <K extends keyof PluginHookHandlerMap>(
      hookName: K,
      handler: PluginHookHandlerMap[K],
      opts?: { priority?: number }
    ) => void;
  };

  export type ChannelMeta = {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    docsLabel?: string;
    blurb: string;
    order?: number;
  };

  export type ChannelCapabilities = {
    chatTypes: Array<"direct" | "group" | "thread">;
    media?: boolean;
    reply?: boolean;
  };

  export type ChannelAccountSnapshot = {
    accountId: string;
    [key: string]: unknown;
  };

  export type ChannelLogSink = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
  };

  export type ChannelConfigAdapter<ResolvedAccount> = {
    listAccountIds: (cfg: OpenClawConfig) => string[];
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
    describeAccount?: (account: ResolvedAccount, cfg: OpenClawConfig) => ChannelAccountSnapshot;
  };

  export type ChannelStatusAdapter<ResolvedAccount> = {
    defaultRuntime?: ChannelAccountSnapshot;
    buildChannelSummary?: (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      defaultAccountId: string;
      snapshot: ChannelAccountSnapshot;
    }) => Record<string, unknown> | Promise<Record<string, unknown>>;
    buildAccountSnapshot?: (params: {
      account: ResolvedAccount;
      cfg: OpenClawConfig;
      runtime?: ChannelAccountSnapshot;
    }) => ChannelAccountSnapshot | Promise<ChannelAccountSnapshot>;
  };

  export type ChannelGatewayContext<ResolvedAccount = unknown> = {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime?: unknown;
    abortSignal: AbortSignal;
    log?: ChannelLogSink;
    channelRuntime?: PluginRuntime["channel"];
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
  };

  export type OutboundDeliveryResult = {
    channel: string;
    messageId: string;
    conversationId?: string;
    meta?: Record<string, unknown>;
  };

  export type ReplyPayload = {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    [key: string]: unknown;
  };

  export type ChannelOutboundContext = {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    replyToId?: string | null;
    threadId?: string | number | null;
    mediaUrl?: string;
  };

  export type ChannelOutboundPayloadContext = ChannelOutboundContext & {
    payload: ReplyPayload;
  };

  export type ChannelOutboundAdapter = {
    deliveryMode: "direct" | "gateway" | "hybrid";
    sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
    sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
  };

  export type ChannelGatewayAdapter<ResolvedAccount = unknown> = {
    startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
  };

  export type ChannelPlugin<ResolvedAccount = unknown> = {
    id: string;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    reload?: { configPrefixes: string[]; noopPrefixes?: string[] };
    config: ChannelConfigAdapter<ResolvedAccount>;
    status?: ChannelStatusAdapter<ResolvedAccount>;
    gateway?: ChannelGatewayAdapter<ResolvedAccount>;
    outbound?: ChannelOutboundAdapter;
  };

  export function emptyPluginConfigSchema(): Record<string, unknown>;

  export function dispatchInboundReplyWithBase(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string;
    route: {
      agentId: string;
      sessionKey: string;
    };
    storePath: string;
    ctxPayload: Record<string, unknown>;
    core: {
      channel: {
        session: {
          recordInboundSession: PluginRuntime["channel"]["session"]["recordInboundSession"];
        };
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"];
        };
      };
    };
    deliver: (payload: OutboundReplyPayload) => Promise<void>;
    onRecordError: (err: unknown) => void;
    onDispatchError: (err: unknown, info: { kind: string }) => void;
    replyOptions?: Record<string, unknown>;
  }): Promise<void>;

  export function formatTextWithAttachmentLinks(
    text: string | undefined,
    mediaUrls: string[]
  ): string;

  export function resolveOutboundMediaUrls(payload: {
    mediaUrls?: string[];
    mediaUrl?: string;
  }): string[];
}

declare module "openclaw/plugin-sdk/compat" {
  export * from "openclaw/plugin-sdk";
}
