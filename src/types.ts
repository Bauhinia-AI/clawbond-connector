import type { PluginRuntime } from "openclaw/plugin-sdk";

export type ClawBondDmDeliveryPreference = "immediate" | "next_chat" | "silent";

export interface ClawBondUserSettings {
  dm_delivery_preference: ClawBondDmDeliveryPreference;
  dm_round_limit: number;
  heartbeat_enabled: boolean;
  heartbeat_interval_minutes: number;
  heartbeat_direction_weights: {
    claw_evolution: number;
    openclaw_skills: number;
    hotspot_curation: number;
    social_exploration: number;
  };
}

export interface ClawBondSyncState {
  last_seen_dm_cursor: string | null;
  heartbeat_last_run_at: string | null;
}

export interface ClawBondAccountConfig {
  enabled?: boolean;
  serverUrl?: string;
  apiBaseUrl?: string;
  socialBaseUrl?: string;
  benchmarkBaseUrl?: string;
  stateRoot?: string;
  bootstrapEnabled?: boolean;
  connectorToken?: string;
  runtimeToken?: string;
  agentId?: string;
  agentName?: string;
  agentPersona?: string;
  agentBio?: string;
  agentTags?: string[];
  agentLanguage?: string;
  secretKey?: string;
  bindCode?: string;
  bindingStatus?: ClawBondBindingStatus;
  inviteWebBaseUrl?: string;
  trustedSenderAgentIds?: string[];
  structuredMessagePrefix?: string;
  notificationsEnabled?: boolean;
  notificationApiUrl?: string;
  notificationAuthToken?: string;
  notificationPollIntervalMs?: number;
  bindStatusPollIntervalMs?: number;
  visibleMainSessionNotes?: boolean;
}

export interface ClawBondAccount {
  accountId: string;
  enabled: boolean;
  configured?: boolean;
  serverUrl: string;
  apiBaseUrl: string;
  socialBaseUrl: string;
  benchmarkBaseUrl: string;
  stateRoot: string;
  bootstrapEnabled: boolean;
  connectorToken: string;
  runtimeToken: string;
  agentId: string;
  agentName: string;
  agentPersona: string;
  agentBio: string;
  agentTags: string[];
  agentLanguage: string;
  secretKey: string;
  bindCode: string;
  ownerUserId: string;
  bindingStatus: ClawBondBindingStatus;
  inviteWebBaseUrl: string;
  trustedSenderAgentIds: string[];
  structuredMessagePrefix: string;
  notificationsEnabled: boolean;
  notificationApiUrl: string;
  notificationAuthToken: string;
  notificationPollIntervalMs: number;
  bindStatusPollIntervalMs: number;
  visibleMainSessionNotes: boolean;
  channel: "clawbond";
}

export interface ClawBondPluginConfig extends ClawBondAccountConfig {
  accounts?: Record<string, ClawBondAccountConfig>;
}

export type ClawBondBindingStatus = "unregistered" | "pending" | "bound";

export interface ClawBondStoredCredentials {
  platform_base_url: string;
  social_base_url?: string;
  agent_access_token: string;
  agent_id: string;
  agent_name: string;
  secret_key: string;
  bind_code?: string;
  owner_user_id?: string;
  binding_status: Exclude<ClawBondBindingStatus, "unregistered">;
  invite_web_base_url?: string;
}

export interface ClawBondStoredAgent {
  agentKey: string;
  credentials: ClawBondStoredCredentials;
}

export interface ClawBondAgentRegistration {
  accessToken: string;
  agentId: string;
  secretKey: string;
  bindCode: string;
}

export interface ClawBondAgentBindStatus {
  bound: boolean;
  userId?: string;
  username?: string;
}

export interface ClawBondAgentSelfProfile {
  id: string;
  name: string;
  userId?: string;
  bindCode?: string;
}

export interface ClawBondStructuredMessageEnvelope {
  kind: string;
  schema?: number;
  taskId?: string;
  title?: string;
  summary?: string;
  body?: string;
  payload?: unknown;
}

export type ClawBondDeliveryPath =
  | "platform_realtime"
  | "message_polling"
  | "notification_realtime"
  | "notification_polling";

export interface ClawBondInvokeMessage {
  type: "invoke";
  requestId: string;
  conversationId: string;
  timestamp: string;
  turnId?: string;
  sourceAgentId: string;
  prompt: string;
  rawPrompt?: string;
  sessionKey?: string;
  structuredEnvelope?: ClawBondStructuredMessageEnvelope;
  sourceKind?: "message" | "notification" | "connection_request" | "connection_request_response";
  notificationId?: string;
  traceId?: string;
  deliveryPath?: ClawBondDeliveryPath;
  context?: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
}

export interface ClawBondReplyMessage {
  type: "reply";
  requestId?: string;
  conversationId?: string;
  turnId?: string;
  agentId: string;
  content: string;
  sessionKey?: string;
  toAgentId?: string;
}

export interface ClawBondPresenceMessage {
  type: "presence";
  agentId: string;
  status: "online" | "offline";
}

export interface ClawBondPlatformSocketMessageInbound {
  event: "message";
  from_agent_id: string;
  conversation_id?: string;
  content: string;
  msg_type?: string;
  sender_type?: "agent" | "user" | "system";
  timestamp: string;
}

export interface ClawBondPlatformSocketNotificationInbound {
  event: "notification";
  id: string;
  sender_id: string;
  sender_type?: "agent" | "user" | "system";
  noti_type?: string;
  content: string;
  created_at: string;
}

export interface ClawBondPlatformSocketErrorInbound {
  event: "error";
  reason: string;
}

export interface ClawBondPlatformSocketConnectionRequestInbound {
  event: "connection_request";
  request_id: string;
  conversation_id: string;
  from_agent_id: string;
  message?: string | null;
  status: "pending";
}

export interface ClawBondPlatformSocketConnectionRequestResponseInbound {
  event: "connection_request_response";
  request_id: string;
  conversation_id: string;
  from_agent_id: string;
  message?: string | null;
  status: "accepted" | "rejected";
}

export type ClawBondPlatformSocketInbound =
  | ClawBondPlatformSocketMessageInbound
  | ClawBondPlatformSocketNotificationInbound
  | ClawBondPlatformSocketErrorInbound
  | ClawBondPlatformSocketConnectionRequestInbound
  | ClawBondPlatformSocketConnectionRequestResponseInbound;

export interface ClawBondPlatformSocketOutbound {
  event: "message";
  to_agent_id: string;
  content: string;
}

export interface ClawBondNotification {
  id: string;
  senderId: string;
  senderType: "user" | "agent" | "system";
  notificationType?: string;
  content: string;
  isRead: boolean;
  createdAt: string;
}

export type ClawBondPendingInboxItemStatus = "pending" | "handled";

export type ClawBondInboxHandledBy =
  | "clawbond_dm"
  | "clawbond_notifications"
  | "clawbond_connection_requests"
  | "manual";

export interface ClawBondPendingInboxItem {
  id: string;
  accountId: string;
  fingerprint: string;
  traceId: string;
  sourceKind: NonNullable<ClawBondInvokeMessage["sourceKind"]>;
  peerId: string;
  peerLabel: string;
  summary: string;
  content: string;
  receivedAt: string;
  deliveryPath?: ClawBondDeliveryPath;
  status: ClawBondPendingInboxItemStatus;
  requestId?: string;
  conversationId?: string;
  notificationId?: string;
  requestKey?: string;
  wakeRequestedAt: string | null;
  wakeCount: number;
  handledAt: string | null;
  handledBy: ClawBondInboxHandledBy | null;
  responsePreview: string | null;
}

export type ClawBondActivityEvent =
  | "inbound_received"
  | "main_inbox_queued"
  | "main_run_requested"
  | "main_prompt_injected"
  | "main_run_escalated"
  | "main_run_failed"
  | "pending_handled"
  | "reply_sent"
  | "notification_reply_sent"
  | "background_run_started"
  | "background_run_completed"
  | "background_run_failed";

export interface ClawBondActivityEntry {
  id: string;
  recordedAt: string;
  accountId: string;
  agentId: string;
  sessionKey: string;
  itemId?: string;
  traceId?: string;
  requestId?: string;
  conversationId?: string;
  peerId?: string;
  peerLabel?: string;
  deliveryPath?: ClawBondDeliveryPath;
  sourceKind?: ClawBondInvokeMessage["sourceKind"] | "system";
  event: ClawBondActivityEvent;
  summary: string;
  preview?: string;
  error?: string;
}

export type ClawBondRuntime = PluginRuntime;
