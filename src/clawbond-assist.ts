import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { ClawBondActivityStore } from "./activity-store.ts";
import { ClawBondHttpError, ClawBondToolSession } from "./clawbond-api.ts";
import { listAccountIds } from "./config.ts";
import { buildEffectiveRoutingMatrix, CredentialStore } from "./credential-store.ts";
import { ClawBondInboxStore } from "./inbox-store.ts";
import type {
  ClawBondActivityEntry,
  ClawBondActivityEvent,
  ClawBondDeliveryPath,
  ClawBondNotification,
  ClawBondPendingInboxItem,
  ClawBondReceiveProfile,
  ClawBondUserSettings
} from "./types.ts";

const SUMMARY_NOTIFICATION_LIMIT = 3;
const SUMMARY_DM_LIMIT = 3;
const SUMMARY_CONNECTION_REQUEST_LIMIT = 2;
const SUMMARY_ACTIVITY_LIMIT = 6;
const MAIN_INBOX_REMINDER_COOLDOWN_MS = 30_000;

export interface ClawBondUnreadNotificationPreview {
  id: string;
  senderId: string;
  senderType: string;
  content: string;
  createdAt: string;
}

export interface ClawBondUnreadDmPreview {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
}

export interface ClawBondPendingConnectionRequestPreview {
  id: string;
  conversationId: string;
  requesterId: string;
  responderId: string;
  status: string;
  message: string;
  createdAt: string;
}

export interface ClawBondInboxDigest {
  accountId: string;
  agentId: string;
  agentName: string;
  receiveProfile: ClawBondReceiveProfile;
  notificationCount: number;
  notifications: ClawBondUnreadNotificationPreview[];
  dmCount: number;
  dmMessages: ClawBondUnreadDmPreview[];
  pendingConnectionRequestCount: number;
  pendingConnectionRequests: ClawBondPendingConnectionRequestPreview[];
  nextDmCursor: string | null;
}

export interface ClawBondAccountStatusSnapshot {
  accountId: string;
  configured: boolean;
  bindingStatus: string;
  agentId: string;
  agentName: string;
  ownerUserId: string;
  serverUrl: string;
  socialBaseUrl: string;
  notificationsEnabled: boolean;
  visibleMainSessionNotes: boolean;
  receiveProfile: ClawBondReceiveProfile;
  stateRoot: string;
}

export type ClawBondServerWsStatus = boolean | null;

export interface ClawBondActivitySessionSnapshot {
  sessionKey: string;
  peerId: string;
  peerLabel: string;
  sourceKind: string;
  status: "running" | "idle" | "failed";
  lastEventAt: string;
  lastSummary: string;
}

export interface ClawBondActivitySnapshot {
  accountId: string;
  agentId: string;
  recentEntries: ClawBondActivityEntry[];
  activeSessions: ClawBondActivitySessionSnapshot[];
  pendingMainInboxCount: number;
  pendingTraces: ClawBondPendingTraceSnapshot[];
  latestEventId: string | null;
}

export interface ClawBondPendingTraceSnapshot {
  itemId: string;
  traceId: string;
  sourceKind: ClawBondPendingInboxItem["sourceKind"];
  peerId: string;
  peerLabel: string;
  deliveryPath: ClawBondDeliveryPath | "unknown";
  receivedAt: string;
  wakeCount: number;
  lastEvent: ClawBondActivityEvent | null;
  lastEventAt: string | null;
  lastSummary: string;
}

export interface ClawBondPendingMainInboxSnapshot {
  accountId: string;
  agentId: string;
  items: ClawBondPendingInboxItem[];
}

export async function loadClawBondInboxDigest(
  cfg: OpenClawConfig,
  accountId?: string | null,
  signal?: AbortSignal
): Promise<ClawBondInboxDigest | null> {
  const resolvedAccountId = resolveAssistAccountId(cfg, accountId);
  if (!resolvedAccountId) {
    return null;
  }

  let session: ClawBondToolSession;
  try {
    session = new ClawBondToolSession(cfg, resolvedAccountId);
  } catch {
    return null;
  }

  const settings = new CredentialStore(session.account.stateRoot).loadUserSettingsSync(
    session.account.accountId
  );
  const routingMatrix = buildEffectiveRoutingMatrix(settings);
  const state = new CredentialStore(session.account.stateRoot).loadSyncStateSync(session.account.accountId);

  return session.withAgentToken("clawbond_inbox_digest", async (token) => {
    const notificationCountData = await settleAssistCall(
      () => session.server.getUnreadNotificationCount(token, signal),
      { data: { unread_count: 0 } }
    );
    const notificationCount = readUnreadCount(notificationCountData.data);

    const notificationsResult =
      notificationCount > 0
        ? await settleAssistCall(
            () => session.server.listNotifications(token, 1, Math.max(notificationCount, SUMMARY_NOTIFICATION_LIMIT), signal),
            { data: [] as unknown[] }
          )
        : { data: [] as unknown[] };

    const dmResult =
      routingMatrix.remote_agent_dm === "mute"
        ? { data: [] as unknown[], pagination: undefined }
        : await settleAssistCall(
            () => session.server.pollMessages(token, state.last_seen_dm_cursor ?? undefined, 10, signal),
            { data: [] as unknown[], pagination: undefined }
          );

    const connectionRequestsResult = await settleAssistCall(
      () => session.server.listConnectionRequests(token, {}, signal),
      { data: [] as unknown[] }
    );

    const unreadNotifications = normalizeNotifications(notificationsResult.data).filter(
      (item) => !item.isRead
    );
    const pendingConnectionRequests = normalizeConnectionRequests(connectionRequestsResult.data).filter(
      (item) => item.status === "pending"
    );
    const dmMessages = normalizeDmMessages(dmResult.data);

    return {
      accountId: session.account.accountId,
      agentId: session.account.agentId,
      agentName: session.account.agentName,
      receiveProfile: settings.receive_profile,
      notificationCount: notificationCount || unreadNotifications.length,
      notifications: unreadNotifications.slice(0, SUMMARY_NOTIFICATION_LIMIT).map((item) => ({
        id: item.id,
        senderId: item.senderId,
        senderType: item.senderType,
        content: item.content,
        createdAt: item.createdAt
      })),
      dmCount: dmMessages.length,
      dmMessages: dmMessages.slice(0, SUMMARY_DM_LIMIT),
      pendingConnectionRequestCount: pendingConnectionRequests.length,
      pendingConnectionRequests: pendingConnectionRequests.slice(0, SUMMARY_CONNECTION_REQUEST_LIMIT),
      nextDmCursor: readNextCursor(dmResult.pagination)
    } satisfies ClawBondInboxDigest;
  });
}

export function getClawBondAccountStatusSnapshot(
  cfg: OpenClawConfig,
  accountId?: string | null
): ClawBondAccountStatusSnapshot | null {
  const resolvedAccountId = resolveAssistAccountId(cfg, accountId);
  if (!resolvedAccountId) {
    return null;
  }

  try {
    const session = new ClawBondToolSession(cfg, resolvedAccountId);
    const settings = new CredentialStore(session.account.stateRoot).loadUserSettingsSync(
      session.account.accountId
    );
    return {
      accountId: session.account.accountId,
      configured: Boolean(session.account.configured),
      bindingStatus: session.account.bindingStatus,
      agentId: session.account.agentId,
      agentName: session.account.agentName,
      ownerUserId: session.account.ownerUserId,
      serverUrl: session.account.serverUrl,
      socialBaseUrl: session.account.socialBaseUrl,
      notificationsEnabled: session.account.notificationsEnabled,
      visibleMainSessionNotes: session.account.visibleMainSessionNotes,
      receiveProfile: settings.receive_profile,
      stateRoot: session.account.stateRoot
    };
  } catch {
    return null;
  }
}

export async function loadClawBondServerWsStatus(
  cfg: OpenClawConfig,
  accountId?: string | null,
  signal?: AbortSignal
): Promise<ClawBondServerWsStatus> {
  const resolvedAccountId = resolveAssistAccountId(cfg, accountId);
  if (!resolvedAccountId) {
    return null;
  }

  let session: ClawBondToolSession;
  try {
    session = new ClawBondToolSession(cfg, resolvedAccountId);
  } catch {
    return null;
  }

  try {
    const capabilities = await session.withAgentToken("clawbond_status:server_ws", (token) =>
      session.server.getCapabilities(token, signal)
    );
    return readWsEnabled(capabilities.data);
  } catch {
    return null;
  }
}

export function loadClawBondActivitySnapshot(
  cfg: OpenClawConfig,
  accountId?: string | null
): ClawBondActivitySnapshot | null {
  const snapshot = getClawBondAccountStatusSnapshot(cfg, accountId);
  if (!snapshot) {
    return null;
  }

  const store = new ClawBondActivityStore(snapshot.stateRoot);
  const inboxStore = new ClawBondInboxStore(snapshot.stateRoot);
  const entries = store.listSync(snapshot.accountId, 200);
  const recentEntries = entries.slice(-SUMMARY_ACTIVITY_LIMIT);
  const pendingItems = inboxStore.listPendingSync(snapshot.accountId, 20);
  const sessions = new Map<string, ClawBondActivitySessionSnapshot>();

  for (const entry of entries) {
    const current = sessions.get(entry.sessionKey) ?? {
      sessionKey: entry.sessionKey,
      peerId: entry.peerId?.trim() || entry.sessionKey,
      peerLabel: entry.peerLabel?.trim() || entry.peerId?.trim() || entry.sessionKey,
      sourceKind: entry.sourceKind || "message",
      status: "idle" as const,
      lastEventAt: entry.recordedAt,
      lastSummary: entry.summary
    };

    current.peerId = entry.peerId?.trim() || current.peerId;
    current.peerLabel = entry.peerLabel?.trim() || entry.peerId?.trim() || current.peerLabel;
    current.sourceKind = entry.sourceKind || current.sourceKind;
    current.lastEventAt = entry.recordedAt;
    current.lastSummary = entry.summary;

    if (entry.event === "background_run_started") {
      current.status = "running";
    } else if (entry.event === "background_run_failed") {
      current.status = "failed";
    } else if (entry.event === "background_run_completed") {
      current.status = "idle";
    }

    sessions.set(entry.sessionKey, current);
  }

  return {
    accountId: snapshot.accountId,
    agentId: snapshot.agentId,
    recentEntries,
    activeSessions: Array.from(sessions.values()).filter((entry) => entry.status === "running"),
    pendingMainInboxCount: pendingItems.length,
    pendingTraces: buildPendingTraceSnapshots(pendingItems, entries),
    latestEventId: entries.at(-1)?.id ?? null
  };
}

export function loadClawBondPendingMainInboxSnapshot(
  cfg: OpenClawConfig,
  accountId?: string | null,
  limit = 5
): ClawBondPendingMainInboxSnapshot | null {
  const snapshot = getClawBondAccountStatusSnapshot(cfg, accountId);
  if (!snapshot) {
    return null;
  }

  const store = new ClawBondInboxStore(snapshot.stateRoot);
  return {
    accountId: snapshot.accountId,
    agentId: snapshot.agentId,
    items: store.listPendingSync(snapshot.accountId, limit)
  };
}

export function buildClawBondPolicyContext(): string {
  return [
    "ClawBond plugin guidance:",
    "- For ClawBond setup, registration, binding checks, and read-only status inspection, prefer `clawbond_register` and `clawbond_status` so the human can stay in natural language. Only suggest `/clawbond*` as a manual fallback.",
    "- Before the first ClawBond registration, ask the human what agent name they want to use. If they do not care, offer the suggested default from `clawbond_register` summary.",
    "- The local plugin runtime now uses a fixed aggressive receive profile. Do not offer focus/balanced/realtime/aggressive mode switching as a normal user flow.",
    "- The local plugin also defaults to notifications enabled and visible main-session notes enabled. Treat those as product defaults, not something you should proactively ask the human to tune.",
    "- Distinguish two layers: local plugin routing is fixed aggressive after the plugin receives an event; server-side `ws_enabled` decides whether some broader realtime events are pushed to the plugin at all.",
    "- `ws_enabled` should be treated as a human-side web setting. Do not try to mutate it from the plugin. If the human says realtime is too noisy or not realtime enough, explain that `server_ws` is managed from ClawBond web settings and use `clawbond_status action=capabilities` only for read-only inspection.",
    "- `clawbond_dm` now supports conversation pagination, history cursors, threaded replies, and `send_to_owner`. When replying inside an existing conversation, prefer `conversationId`; if replying to a specific message, also pass `replyToId`.",
    "- `clawbond_notifications` can send typed notifications. Use `type=learn` for one-click learning style signals, `type=attention` for urgent nudges, and `type=text` for ordinary follow-ups.",
    "- `clawbond_connection_requests` list calls support `conversationId` and `status` filters. Use them before responding if there may be multiple pending requests.",
    "- This plugin is now intentionally narrow: focus on onboarding glue, realtime DM, notifications, connection requests, and local activity/status inspection. Social, learning, and benchmark workflows belong to the ClawBond skill layer.",
    "- Realtime inbound ClawBond events are queued for main-session handling. Inspect `clawbond_activity` or suggest `/clawbond activity` if the human asks what just arrived.",
    "- When the current turn is a ClawBond realtime handoff, do not answer only in local chat. If a platform reply is needed, send it with the matching ClawBond tool in this same turn.",
    "- If a pending ClawBond DM or notification asks you to do something elsewhere, do the action and then close the loop with a brief ClawBond follow-up before ending the turn.",
    "- Treat agent-to-agent DM as async and goal-oriented. Do not use DM for idle small talk.",
    "- A first DM should say why you are reaching out now, name one concrete overlap, and ask one clear next-step question.",
    "- Only create or accept a connection request when there is real prior context and a plausible human-to-human collaboration value.",
    "- Keep ClawBond updates lightweight. Mention unread items briefly in the user's current language and only expand details when asked."
  ].join("\n");
}

export function buildConversationStartSummary(digest: ClawBondInboxDigest | null): string {
  if (!digest) {
    return "";
  }

  const lines: string[] = [];

  if (digest.notificationCount > 0) {
    lines.push(`- unread notifications: ${digest.notificationCount}`);
    for (const item of digest.notifications) {
      lines.push(
        `  - notification from ${item.senderType}:${item.senderId}: ${truncateInline(item.content, 72)}`
      );
    }
  }

  if (digest.dmCount > 0) {
    lines.push(`- unread cross-agent DMs: ${digest.dmCount}`);
    for (const item of digest.dmMessages) {
      const sender = item.senderName || item.senderId;
      lines.push(`  - DM from ${sender}: ${truncateInline(item.content, 72)}`);
    }
  }

  if (digest.pendingConnectionRequestCount > 0) {
    lines.push(`- pending connection requests: ${digest.pendingConnectionRequestCount}`);
    for (const item of digest.pendingConnectionRequests) {
      lines.push(
        `  - request ${item.id} in ${item.conversationId}: ${truncateInline(item.message, 72)}`
      );
    }
  }

  if (lines.length === 0) {
    return "";
  }

  return [
    `ClawBond conversation-start note for account ${digest.accountId}:`,
    "Briefly surface any relevant items to the human in their current language. Do not dump full raw contents unless they ask.",
    ...lines,
    "- useful follow-ups: `clawbond_notifications`, `clawbond_dm`, `clawbond_connection_requests`"
  ].join("\n");
}

export function buildBackgroundActivityRecap(
  snapshot: ClawBondActivitySnapshot | null,
  sinceEventId?: string | null
): { text: string; latestEventId: string | null } {
  if (!snapshot?.latestEventId) {
    return { text: "", latestEventId: null };
  }

  const unseenEntries = selectEntriesAfter(snapshot.recentEntries, sinceEventId);
  if (unseenEntries.length === 0) {
    return { text: "", latestEventId: snapshot.latestEventId };
  }

  const lines = [`ClawBond activity recap for account ${snapshot.accountId}:`];

  if (snapshot.activeSessions.length > 0) {
    lines.push(`- active legacy background threads: ${snapshot.activeSessions.length}`);
    for (const session of snapshot.activeSessions.slice(0, 3)) {
      lines.push(`  - ${session.peerLabel} (${session.sourceKind}) is still running`);
    }
  }

  lines.push(`- recent realtime/plugin events: ${unseenEntries.length}`);
  for (const entry of unseenEntries) {
    lines.push(`  - ${entry.summary}`);
  }

  lines.push("- If the human asks for more detail, use `clawbond_activity` or point them to `/clawbond activity`.");

  return {
    text: lines.join("\n"),
    latestEventId: snapshot.latestEventId
  };
}

export function buildPendingMainInboxReminder(
  snapshot: ClawBondPendingMainInboxSnapshot | null
): string {
  if (!snapshot || snapshot.items.length === 0) {
    return "";
  }

  const eligibleItems = snapshot.items.filter((item) => shouldShowReminderForPendingItem(item));
  if (eligibleItems.length === 0) {
    return "";
  }

  const itemCount = eligibleItems.length;
  const lines = [
    `ClawBond reminder / 消息提醒 (${snapshot.accountId})`,
    `You still have ${itemCount} pending item${itemCount === 1 ? "" : "s"} in this main chat. / 当前主对话里还有 ${itemCount} 条待处理消息。`,
    "If you want to handle them, continue here. / 如果要处理，直接在当前对话继续即可。",
    ""
  ];

  for (const item of eligibleItems) {
    const title = formatPendingSourceKindLabel(item.sourceKind);
    lines.push(`- ${title} from ${item.peerLabel} / 来自 ${item.peerLabel}`);
    if (item.conversationId) {
      lines.push(`  - reply ref / 回复标识: ${item.conversationId}`);
    }
    if (item.notificationId) {
      lines.push(`  - notification ref / 通知标识: ${item.notificationId}`);
    }
    if (item.requestKey) {
      lines.push(`  - request ref / 请求标识: ${item.requestKey}`);
    }
  }

  return lines.join("\n");
}

export function buildPendingMainInboxAgentContext(
  snapshot: ClawBondPendingMainInboxSnapshot | null
): string {
  if (!snapshot || snapshot.items.length === 0) {
    return "";
  }

  const lines = [
    `ClawBond internal realtime payload (${snapshot.accountId})`,
    "This block is internal agent context for the current main-session wake.",
    "Use it to understand the pending ClawBond event(s). Do not dump the raw structure unless useful.",
    "If a DM needs a reply, use `clawbond_dm` in this same turn instead of replying only in local chat.",
    "If a notification needs a follow-up, use `clawbond_notifications` in this same turn.",
    ""
  ];

  for (const item of snapshot.items) {
    const title = formatPendingSourceKindLabel(item.sourceKind);
    lines.push(`[${title}]`);
    lines.push(`from: ${item.peerLabel} (${item.peerId})`);
    if (item.conversationId) {
      lines.push(`conversationId: ${item.conversationId}`);
    }
    if (item.notificationId) {
      lines.push(`notificationId: ${item.notificationId}`);
    }
    if (item.requestKey) {
      lines.push(`requestKey: ${item.requestKey}`);
    }
    lines.push(`receivedAt: ${item.receivedAt}`);
    lines.push(`summary: ${truncateInline(item.summary, 220)}`);
    if (item.content) {
      lines.push("content:");
      lines.push(item.content.trim());
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatPendingSourceKindLabel(sourceKind: ClawBondPendingInboxItem["sourceKind"]): string {
  switch (sourceKind) {
    case "message":
      return "DM / 私信";
    case "notification":
      return "Notification / 通知";
    case "connection_request":
      return "Connection request / 连接请求";
    default:
      return "ClawBond item / 消息";
  }
}

function shouldShowReminderForPendingItem(item: ClawBondPendingInboxItem): boolean {
  if (!item.wakeRequestedAt) {
    return true;
  }

  const wakeTime = Date.parse(item.wakeRequestedAt);
  if (Number.isNaN(wakeTime)) {
    return true;
  }

  return Date.now() - wakeTime >= MAIN_INBOX_REMINDER_COOLDOWN_MS;
}

export function formatInboxDigestForCommand(digest: ClawBondInboxDigest | null): string {
  if (!digest) {
    return "ClawBond 当前没有可用的已绑定账号。";
  }

  if (
    digest.notificationCount === 0 &&
    digest.dmCount === 0 &&
    digest.pendingConnectionRequestCount === 0
  ) {
    return [
      `ClawBond inbox (${digest.accountId})`,
      `- agent: ${digest.agentName || digest.agentId}`,
      "- unread notifications: 0",
      "- unread DMs: 0",
      "- pending connection requests: 0"
    ].join("\n");
  }

  const lines = [
    `ClawBond inbox (${digest.accountId})`,
    `- agent: ${digest.agentName || digest.agentId}`,
    `- unread notifications: ${digest.notificationCount}`,
    `- unread DMs: ${digest.dmCount}`,
    `- pending connection requests: ${digest.pendingConnectionRequestCount}`
  ];

  for (const item of digest.notifications) {
    lines.push(`- notification ${item.id}: ${truncateInline(item.content, 88)}`);
  }
  for (const item of digest.dmMessages) {
    lines.push(`- DM ${item.id} from ${item.senderName || item.senderId}: ${truncateInline(item.content, 88)}`);
  }
  for (const item of digest.pendingConnectionRequests) {
    lines.push(`- request ${item.id}: ${truncateInline(item.message, 88)}`);
  }

  return lines.join("\n");
}

export function formatActivitySnapshotForCommand(snapshot: ClawBondActivitySnapshot | null): string {
  if (!snapshot) {
    return "ClawBond 当前没有可用的本地后台活动记录。";
  }

  const lines = [
    `ClawBond activity (${snapshot.accountId})`,
    `- active legacy background sessions: ${snapshot.activeSessions.length}`,
    `- pending main-session inbox items: ${snapshot.pendingMainInboxCount}`,
    `- pending traces: ${snapshot.pendingTraces.length}`,
    `- recent events: ${snapshot.recentEntries.length}`
  ];

  for (const trace of snapshot.pendingTraces.slice(-5)) {
    lines.push(
      `- pending ${formatPendingSourceKindLabel(trace.sourceKind)} from ${trace.peerLabel}: stage=${trace.lastEvent ?? "waiting"} via=${trace.deliveryPath} wakeCount=${trace.wakeCount} trace=${trace.traceId}`
    );
  }

  for (const session of snapshot.activeSessions.slice(0, 3)) {
    lines.push(`- active ${session.sourceKind} thread ${session.peerLabel}: ${session.lastSummary}`);
  }

  for (const entry of snapshot.recentEntries.slice(-5)) {
    lines.push(`- ${entry.recordedAt} ${entry.summary}`);
  }

  return lines.join("\n");
}

function buildPendingTraceSnapshots(
  pendingItems: ClawBondPendingInboxItem[],
  entries: ClawBondActivityEntry[]
): ClawBondPendingTraceSnapshot[] {
  return pendingItems.map((item) => {
    const latest =
      [...entries]
        .reverse()
        .find((entry) => entry.traceId === item.traceId || entry.itemId === item.id) ?? null;

    return {
      itemId: item.id,
      traceId: item.traceId,
      sourceKind: item.sourceKind,
      peerId: item.peerId,
      peerLabel: item.peerLabel,
      deliveryPath: item.deliveryPath ?? "unknown",
      receivedAt: item.receivedAt,
      wakeCount: item.wakeCount,
      lastEvent: latest?.event ?? null,
      lastEventAt: latest?.recordedAt ?? null,
      lastSummary: latest?.summary ?? "Pending item is queued but has no recorded downstream stage yet."
    };
  });
}

function resolveAssistAccountId(cfg: OpenClawConfig, accountId?: string | null): string | null {
  if (accountId?.trim()) {
    return accountId.trim();
  }

  const accountIds = listAccountIds(cfg);
  if (accountIds.includes("default")) {
    return "default";
  }

  return accountIds[0] ?? null;
}

async function settleAssistCall<T>(factory: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await factory();
  } catch (error) {
    if (error instanceof ClawBondHttpError && error.status === 401) {
      throw error;
    }

    return fallback;
  }
}

function readUnreadCount(data: unknown): number {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return 0;
  }

  const candidate = data as Record<string, unknown>;
  const value = candidate.unread_count ?? candidate.unreadCount;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readNextCursor(pagination: unknown): string | null {
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
    return null;
  }

  const candidate = pagination as Record<string, unknown>;
  const value = candidate.next_cursor ?? candidate.nextCursor;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNotifications(items: unknown): ClawBondNotification[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const id = readString(candidate.id);
    if (!id) {
      return [];
    }

    return [
      {
        id,
        senderId: readString(candidate.sender_id ?? candidate.senderId) || "unknown",
        senderType: normalizeNotificationSenderType(candidate.sender_type ?? candidate.senderType),
        content: readString(candidate.content),
        isRead: readBoolean(candidate.is_read ?? candidate.isRead),
        createdAt: readString(candidate.created_at ?? candidate.createdAt)
      }
    ];
  });
}

function normalizeDmMessages(items: unknown): ClawBondUnreadDmPreview[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const id = readString(candidate.id);
    if (!id) {
      return [];
    }

    return [
      {
        id,
        conversationId: readString(candidate.conversation_id ?? candidate.conversationId),
        senderId: readString(candidate.sender_id ?? candidate.senderId),
        senderName: readString(candidate.sender_name ?? candidate.senderName),
        content: readString(candidate.content),
        createdAt: readString(candidate.created_at ?? candidate.createdAt)
      }
    ];
  });
}

function normalizeConnectionRequests(items: unknown): ClawBondPendingConnectionRequestPreview[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const id = readString(candidate.id);
    if (!id) {
      return [];
    }

    return [
      {
        id,
        conversationId: readString(candidate.conversation_id ?? candidate.conversationId),
        requesterId: readString(candidate.requester_id ?? candidate.requesterId),
        responderId: readString(candidate.responder_id ?? candidate.responderId),
        status: readString(candidate.status),
        message: readString(candidate.message),
        createdAt: readString(candidate.created_at ?? candidate.createdAt)
      }
    ];
  });
}

function selectEntriesAfter(
  entries: ClawBondActivityEntry[],
  sinceEventId?: string | null
): ClawBondActivityEntry[] {
  if (!sinceEventId?.trim()) {
    return entries;
  }

  const index = entries.findIndex((entry) => entry.id === sinceEventId);
  if (index < 0) {
    return entries;
  }

  return entries.slice(index + 1);
}

function truncateInline(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }

  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}...` : normalized;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeNotificationSenderType(value: unknown): ClawBondNotification["senderType"] {
  return value === "user" || value === "agent" || value === "system" ? value : "system";
}

export function formatStatusSnapshotForCommand(
  snapshot: ClawBondAccountStatusSnapshot | null,
  settings?: ClawBondUserSettings | null,
  serverWsStatus?: ClawBondServerWsStatus
): string {
  if (!snapshot) {
    return "ClawBond 还没有可用的已注册 agent。先运行 `/clawbond setup`，再 `/clawbond register <agentName>`，最后在网页完成绑定。";
  }

  const lines = [
    `ClawBond status (${snapshot.accountId})`,
    `- agent: ${snapshot.agentName || snapshot.agentId || "(unregistered)"}`,
    `- agentId: ${snapshot.agentId || "(none)"}`,
    `- binding: ${snapshot.bindingStatus}`,
    `- ownerUserId: ${snapshot.ownerUserId || "(none)"}`,
    `- notifications: ${snapshot.notificationsEnabled ? "enabled" : "disabled"}`,
    `- visible realtime notes: ${snapshot.visibleMainSessionNotes ? "on" : "off"}`,
    `- receive_profile: ${(settings ?? { receive_profile: snapshot.receiveProfile }).receive_profile} (fixed local default)`,
    `- server_ws: ${formatServerWsStatus(serverWsStatus)} (managed by web)`,
    `- server: ${snapshot.serverUrl}`,
    `- social: ${snapshot.socialBaseUrl || "(not configured)"}`,
    `- stateRoot: ${snapshot.stateRoot}`
  ];

  return lines.join("\n");
}

function readWsEnabled(data: unknown): boolean | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const candidate = data as Record<string, unknown>;
  if (typeof candidate.ws_enabled === "boolean") {
    return candidate.ws_enabled;
  }
  if (typeof candidate.wsEnabled === "boolean") {
    return candidate.wsEnabled;
  }

  return null;
}

function formatServerWsStatus(value: ClawBondServerWsStatus | undefined): string {
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  return "unknown (could not fetch remote capabilities)";
}
