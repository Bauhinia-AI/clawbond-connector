import { EventEmitter } from "node:events";

import type {
  ClawBondAccount,
  ClawBondDeliveryPath,
  ClawBondInvokeMessage,
  ClawBondNotification
} from "./types.ts";

interface NotificationConsumerMeta {
  deliveryPath: Extract<ClawBondDeliveryPath, "notification_realtime" | "notification_polling">;
}

type NotificationConsumer = (
  notification: ClawBondNotification,
  meta: NotificationConsumerMeta
) => Promise<void>;

interface WrappedListResponse {
  data?: unknown;
}

interface NotificationClientStartOptions {
  consumer?: NotificationConsumer;
  enablePollingFallback?: boolean;
}

export class NotificationClient extends EventEmitter {
  private readonly account: ClawBondAccount;
  private readonly apiUrl: string;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly processingIds = new Set<string>();
  private consumer: NotificationConsumer | null = null;
  private pollingFallbackEnabled = false;
  private started = false;

  public constructor(account: ClawBondAccount) {
    super();
    this.account = account;
    this.apiUrl = account.notificationApiUrl.replace(/\/+$/, "");
  }

  public setConsumer(consumer: NotificationConsumer | null) {
    this.consumer = consumer;
  }

  public async start(options: NotificationConsumer | NotificationClientStartOptions = {}): Promise<void> {
    const resolved =
      typeof options === "function"
        ? { consumer: options, enablePollingFallback: false }
        : options;
    if (resolved.consumer) {
      this.consumer = resolved.consumer;
    }

    this.stopped = false;
    this.started = true;
    this.pollingFallbackEnabled = resolved.enablePollingFallback === true;

    if (!this.account.notificationsEnabled) {
      this.emit("log", {
        level: "debug",
        message: "Notification sync is disabled for this account"
      });
      return;
    }

    if (!this.apiUrl || !this.account.notificationAuthToken) {
      throw new Error("Notification sync requires notificationApiUrl and notificationAuthToken");
    }

    await this.syncOnce();
    this.configurePollingFallback(this.pollingFallbackEnabled);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.consumer = null;
    this.processingIds.clear();
    this.pollingFallbackEnabled = false;

    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  public async processIncomingNotification(notification: ClawBondNotification): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.emit("log", {
      level: "info",
      message: `Received realtime notification ${notification.id}`
    });
    await this.consumeNotification(notification, "notification_realtime");
  }

  public async syncOnce(): Promise<void> {
    await this.pollOnce();
  }

  public async onRealtimeConnected(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.configurePollingFallback(false);
    await this.syncOnce();
  }

  public onRealtimeDisconnected(): void {
    if (!this.started) {
      return;
    }

    this.configurePollingFallback(true);
  }

  public async sendNotification(content: string): Promise<void> {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }

    const response = await fetch(`${this.apiUrl}/api/agent/notifications/send`, {
      method: "POST",
      headers: buildHeaders(this.account.notificationAuthToken, true),
      body: JSON.stringify({ content: normalized })
    });

    if (!response.ok) {
      throw new Error(
        `Notification reply failed with ${response.status}: ${await readResponseText(response)}`
      );
    }
  }

  public buildInvokeMessage(notification: ClawBondNotification): ClawBondInvokeMessage {
    return this.buildInvokeMessageWithPath(notification, "notification_realtime");
  }

  public buildInvokeMessageWithPath(
    notification: ClawBondNotification,
    deliveryPath: Extract<ClawBondDeliveryPath, "notification_realtime" | "notification_polling">
  ): ClawBondInvokeMessage {
    const sourceAgentId = `notification:${notification.senderType}:${notification.senderId}`;

    return {
      type: "invoke",
      requestId: `notification-${notification.id}`,
      conversationId: sourceAgentId,
      timestamp: notification.createdAt,
      sourceAgentId,
      senderId: notification.senderId,
      senderType: notification.senderType,
      notificationType: notification.notificationType,
      prompt: formatNotificationForAgent(notification),
      rawPrompt: notification.content,
      sourceKind: "notification",
      notificationId: notification.id,
      traceId: `notification:${notification.id}`,
      deliveryPath
    };
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.stopped || !this.consumer) {
      return;
    }

    this.polling = true;

    try {
      const notifications = await this.listUnreadNotifications();

      for (const notification of notifications) {
        await this.consumeNotification(notification, "notification_polling");
      }
    } catch (error) {
      this.emit("log", {
        level: "error",
        message: "Notification polling failed",
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.polling = false;
    }
  }

  private configurePollingFallback(enabled: boolean) {
    this.pollingFallbackEnabled = enabled;

    if (!enabled || this.stopped) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }

    if (this.timer) {
      return;
    }

    this.emit("log", {
      level: "info",
      message: `Notification polling fallback enabled (${this.account.notificationPollIntervalMs}ms)`
    });
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.account.notificationPollIntervalMs);
  }

  private async listUnreadNotifications(): Promise<ClawBondNotification[]> {
    const response = await fetch(`${this.apiUrl}/api/agent/notifications?page=1&limit=20`, {
      method: "GET",
      headers: buildHeaders(this.account.notificationAuthToken)
    });

    if (!response.ok) {
      throw new Error(
        `Notification list failed with ${response.status}: ${await readResponseText(response)}`
      );
    }

    const payload = (await response.json()) as WrappedListResponse;
    const items = Array.isArray(payload.data) ? payload.data : [];

    return items
      .map(normalizeNotification)
      .filter((item): item is ClawBondNotification => item !== null && !item.isRead)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async consumeNotification(
    notification: ClawBondNotification,
    deliveryPath: Extract<ClawBondDeliveryPath, "notification_realtime" | "notification_polling">
  ): Promise<void> {
    if (this.stopped || !this.consumer) {
      return;
    }

    if (this.processingIds.has(notification.id)) {
      this.emit("log", {
        level: "debug",
        message: `Skipped duplicate notification ${notification.id}`
      });
      return;
    }

    this.processingIds.add(notification.id);

    try {
      await this.consumer(notification, { deliveryPath });
      this.emit("log", {
        level: "info",
        message: `Queued notification ${notification.id} via ${deliveryPath}`
      });
    } catch (error) {
      this.emit("log", {
        level: "warn",
        message: `Failed to process notification ${notification.id}`,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.processingIds.delete(notification.id);
    }
  }
}

function normalizeNotification(value: unknown): ClawBondNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = readString(candidate.id);
  const senderId = readString(candidate.sender_id);
  const content = readString(candidate.content);
  const createdAt = readString(candidate.created_at);

  if (!id || !senderId || !content || !createdAt) {
    return null;
  }

  const senderType = normalizeSenderType(candidate.sender_type);

  return {
    id,
    senderId,
    senderType,
    notificationType: readString(candidate.noti_type),
    content,
    isRead: candidate.is_read === true,
    createdAt
  };
}

function normalizeSenderType(value: unknown): "user" | "agent" | "system" {
  if (value === "user" || value === "agent" || value === "system") {
    return value;
  }

  return "system";
}

function formatNotificationForAgent(notification: ClawBondNotification): string {
  return [
    "ClawBond notification",
    `Notification ID: ${notification.id}`,
    `Sender type: ${notification.senderType}`,
    `Sender ID: ${notification.senderId}`,
    notification.notificationType ? `Notification type: ${notification.notificationType}` : "",
    "",
    notification.content
  ]
    .filter(Boolean)
    .join("\n");
}

function buildHeaders(token: string, includeJsonContentType = false): HeadersInit {
  return includeJsonContentType
    ? {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      }
    : {
        Authorization: `Bearer ${token}`
      };
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}
