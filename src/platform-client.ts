import { EventEmitter } from "node:events";
import WebSocket from "ws";

import type {
  ClawBondAccount,
  ClawBondInvokeMessage,
  ClawBondNotification,
  ClawBondPlatformSocketConnectionRequestInbound,
  ClawBondPlatformSocketConnectionRequestResponseInbound,
  ClawBondPlatformSocketMessageInbound,
  ClawBondPlatformSocketNotificationInbound,
  ClawBondPlatformSocketOutbound,
  ClawBondReplyMessage
} from "./types.ts";
import { sanitizeLogString } from "./log-sanitizer.ts";
import { resolveStructuredIncomingPrompt } from "./message-envelope.ts";

const MAX_SESSION_ROUTES = 1000;
const PING_INTERVAL_MS = 30000;
type ConnectReason = "initial_connect" | "reconnect";

interface PlatformClientOptions {
  resolveRuntimeToken?: (reason: ConnectReason) => Promise<string> | string;
}

export class PlatformClient extends EventEmitter {
  private readonly account: ClawBondAccount;
  private readonly options: PlatformClientOptions;
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly sessionRoutes = new Map<string, string>();

  public constructor(account: ClawBondAccount, options: PlatformClientOptions = {}) {
    super();
    this.account = account;
    this.options = options;
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.connect("initial_connect");
  }

  public async stop(): Promise<void> {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearPingTimer();
    this.sessionRoutes.clear();

    this.socket?.close();
    this.socket = null;
  }

  public async sendReply(message: ClawBondReplyMessage): Promise<void> {
    const toAgentId = message.toAgentId ?? this.resolveRoute(message.sessionKey);

    if (!toAgentId) {
      throw new Error("No peer route found for outbound ClawBond message");
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("PlatformClient is not connected");
    }

    this.sendJson({
      event: "message",
      to_agent_id: toAgentId,
      content: message.content
    });
    this.emit("reply", message);
  }

  public rememberRoute(sessionKey: string, toAgentId: string) {
    if (!sessionKey.trim() || !toAgentId.trim()) {
      return;
    }

    if (this.sessionRoutes.has(sessionKey)) {
      this.sessionRoutes.delete(sessionKey);
    }

    this.sessionRoutes.set(sessionKey, toAgentId);

    while (this.sessionRoutes.size > MAX_SESSION_ROUTES) {
      const oldest = this.sessionRoutes.keys().next().value;
      if (!oldest) {
        break;
      }
      this.sessionRoutes.delete(oldest);
    }
  }

  public simulateInvoke(message: ClawBondInvokeMessage) {
    this.emit("invoke", message);
  }

  private async connect(reason: ConnectReason): Promise<void> {
    const runtimeToken = await this.resolveRuntimeToken(reason);
    const wsUrl = buildServerWsUrl(this.account.serverUrl, runtimeToken);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;

      let settled = false;

      socket.on("open", async () => {
        this.reconnectAttempts = 0;
        this.emit("connected");
        this.emit("log", {
          level: "info",
          message: `Connected to ${formatSocketEndpointForLog(wsUrl)}`
        });

        this.startPingLoop(socket);
        settled = true;
        resolve();
      });

      socket.on("message", (data) => {
        this.handleSocketMessage(data.toString());
      });

      socket.on("close", (code, reason) => {
        const reasonText = sanitizeLogString(reason.toString() || "no reason");
        this.emit("disconnected", { code, reason: reasonText });
        this.emit("log", {
          level: "warn",
          message: `Socket closed (${code}): ${reasonText}`
        });

        this.clearPingTimer();
        this.socket = null;

        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      socket.on("error", (error) => {
        this.emit("log", {
          level: "error",
          message: "Platform socket error",
          error: sanitizeLogString(error instanceof Error ? error.message : String(error))
        });

        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("pong", () => {
        this.emit("log", {
          level: "debug",
          message: "Received WebSocket pong from ClawBond server"
        });
      });
    });
  }

  private handleSocketMessage(raw: string) {
    let payload: unknown;

    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      this.emit("log", {
        level: "warn",
        message: `Ignored non-JSON platform payload: ${sanitizeLogString(raw)}`
      });
      return;
    }

    if (isNotification(payload)) {
      this.emit("notification", normalizeNotification(payload));
      return;
    }

    if (isConnectionRequest(payload)) {
      this.emit("invoke", normalizeConnectionRequestInvoke(payload));
      return;
    }

    if (isConnectionRequestResponse(payload)) {
      this.emit("invoke", normalizeConnectionRequestResponseInvoke(payload));
      return;
    }

    if (!isInboundMessage(payload)) {
      this.emit("log", {
        level: "warn",
        message: "Ignored unsupported platform payload",
        payload
      });
      return;
    }

    const conversationId =
      payload.conversation_id?.trim() || buildConversationId(this.account.agentId, payload.from_agent_id);
    const incoming = resolveStructuredIncomingPrompt(this.account, payload);

    this.emit("invoke", {
      type: "invoke",
      requestId: buildRequestId(payload.from_agent_id, incoming.structuredEnvelope?.taskId),
      conversationId,
      timestamp: payload.timestamp,
      sourceAgentId: payload.from_agent_id,
      sourceKind: "message",
      prompt: incoming.prompt,
      rawPrompt: payload.content,
      structuredEnvelope: incoming.structuredEnvelope
    } satisfies ClawBondInvokeMessage);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) {
      return;
    }

    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);
    this.reconnectAttempts += 1;

    this.emit("log", {
      level: "info",
      message: `Reconnecting in ${delayMs}ms`
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect("reconnect").catch((error) => {
        this.emit("log", {
          level: "error",
          message: "Reconnect failed",
          error: error instanceof Error ? error.message : String(error)
        });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private sendJson(payload: ClawBondPlatformSocketOutbound) {
    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Platform socket is not open");
    }

    socket.send(JSON.stringify(payload));
  }

  private resolveRoute(sessionKey?: string): string | undefined {
    if (!sessionKey) {
      return undefined;
    }

    return this.sessionRoutes.get(sessionKey);
  }

  private startPingLoop(socket: WebSocket) {
    this.clearPingTimer();

    this.pingTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.clearPingTimer();
        return;
      }

      try {
        socket.ping();
      } catch (error) {
        this.emit("log", {
          level: "warn",
          message: "Failed to send WebSocket ping",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, PING_INTERVAL_MS);
  }

  private clearPingTimer() {
    if (!this.pingTimer) {
      return;
    }

    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async resolveRuntimeToken(reason: ConnectReason): Promise<string> {
    const resolved = await this.options.resolveRuntimeToken?.(reason);
    const token = (resolved ?? this.account.runtimeToken).trim();

    if (!token) {
      throw new Error("Missing ClawBond runtime token");
    }

    return token;
  }
}

function buildServerWsUrl(serverUrl: string, runtimeToken: string): string {
  const url = new URL(serverUrl);

  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }

  url.pathname = normalizeWsPath(url.pathname);
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", runtimeToken);

  return url.toString();
}

function formatSocketEndpointForLog(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return sanitizeLogString(wsUrl);
  }
}

function buildConversationId(agentA: string, agentB: string): string {
  return [agentA, agentB].sort().join(":");
}

function buildRequestId(sourceAgentId: string, taskId?: string): string {
  const base =
    taskId?.trim()
      ? `${sourceAgentId}-${taskId}-${Date.now()}`
      : `${sourceAgentId}-${Date.now()}`;

  return `platform-${base.replace(/[^a-zA-Z0-9:_-]+/g, "-")}`;
}

function isInboundMessage(value: unknown): value is ClawBondPlatformSocketMessageInbound {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.event === "message" &&
    typeof candidate.from_agent_id === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.timestamp === "string"
  );
}

function isNotification(value: unknown): value is ClawBondPlatformSocketNotificationInbound {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.event === "notification" &&
    typeof candidate.id === "string" &&
    typeof candidate.sender_id === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.created_at === "string"
  );
}

function isConnectionRequest(value: unknown): value is ClawBondPlatformSocketConnectionRequestInbound {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.event === "connection_request" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.conversation_id === "string" &&
    typeof candidate.from_agent_id === "string" &&
    candidate.status === "pending"
  );
}

function isConnectionRequestResponse(
  value: unknown
): value is ClawBondPlatformSocketConnectionRequestResponseInbound {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.event === "connection_request_response" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.conversation_id === "string" &&
    typeof candidate.from_agent_id === "string" &&
    (candidate.status === "accepted" || candidate.status === "rejected")
  );
}

function normalizeNotification(payload: ClawBondPlatformSocketNotificationInbound): ClawBondNotification {
  return {
    id: payload.id,
    senderId: payload.sender_id,
    senderType: normalizeSenderType(payload.sender_type),
    content: payload.content,
    isRead: false,
    createdAt: payload.created_at
  };
}

function normalizeSenderType(value: unknown): "user" | "agent" | "system" {
  if (value === "user" || value === "agent" || value === "system") {
    return value;
  }

  return "system";
}

function normalizeConnectionRequestInvoke(
  payload: ClawBondPlatformSocketConnectionRequestInbound
): ClawBondInvokeMessage {
  const message = normalizeOptionalText(payload.message) || "No message attached.";

  return {
    type: "invoke",
    requestId: `connection-request-${payload.request_id}`,
    conversationId: payload.conversation_id,
    timestamp: new Date().toISOString(),
    sourceAgentId: payload.from_agent_id,
    sourceKind: "connection_request",
    rawPrompt: message,
    prompt: [
      "ClawBond connection request",
      `Request ID: ${payload.request_id}`,
      `Conversation ID: ${payload.conversation_id}`,
      `From agent: ${payload.from_agent_id}`,
      `Status: ${payload.status}`,
      "",
      "Another agent wants a human introduction. Inspect the context and use the ClawBond connection-request tool to accept or reject when appropriate.",
      "",
      `Request message: ${message}`
    ].join("\n"),
    structuredEnvelope: {
      kind: "connection_request",
      schema: 1,
      taskId: payload.request_id,
      title: "ClawBond connection request",
      summary: `Pending connection request from ${payload.from_agent_id}`,
      payload
    }
  };
}

function normalizeConnectionRequestResponseInvoke(
  payload: ClawBondPlatformSocketConnectionRequestResponseInbound
): ClawBondInvokeMessage {
  const message = normalizeOptionalText(payload.message) || "No response message attached.";

  return {
    type: "invoke",
    requestId: `connection-request-response-${payload.request_id}`,
    conversationId: payload.conversation_id,
    timestamp: new Date().toISOString(),
    sourceAgentId: payload.from_agent_id,
    sourceKind: "connection_request_response",
    rawPrompt: message,
    prompt: [
      "ClawBond connection request response",
      `Request ID: ${payload.request_id}`,
      `Conversation ID: ${payload.conversation_id}`,
      `From agent: ${payload.from_agent_id}`,
      `Status: ${payload.status}`,
      "",
      "A prior ClawBond connection request has been answered. Update your understanding of the collaboration state before taking any next step.",
      "",
      `Response message: ${message}`
    ].join("\n"),
    structuredEnvelope: {
      kind: "connection_request_response",
      schema: 1,
      taskId: payload.request_id,
      title: "ClawBond connection request response",
      summary: `Connection request ${payload.status} by ${payload.from_agent_id}`,
      payload
    }
  };
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWsPath(pathname: string): string {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lastSegment = segments.at(-1);

  if (lastSegment === "api") {
    segments[segments.length - 1] = "ws";
  } else if (lastSegment !== "ws") {
    segments.push("ws");
  }

  return segments.length > 0 ? `/${segments.join("/")}` : "/ws";
}
