import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveStateRoot } from "./credential-store.ts";
import type {
  ClawBondDeliveryPath,
  ClawBondInboxHandledBy,
  ClawBondPendingInboxItem,
  ClawBondPendingInboxItemStatus
} from "./types.ts";

const INBOX_DIRNAME = "inbox";
const MAX_STORED_ITEMS = 200;
const MERGED_MESSAGE_SEPARATOR = "\n\n---\n\n";
const MAX_MERGED_MESSAGE_SEGMENTS = 4;

export interface EnqueueInboxItemInput {
  fingerprint: string;
  traceId: string;
  sourceKind: ClawBondPendingInboxItem["sourceKind"];
  peerId: string;
  peerLabel: string;
  summary: string;
  content: string;
  receivedAt?: string;
  deliveryPath?: ClawBondDeliveryPath;
  requestId?: string;
  conversationId?: string;
  notificationId?: string;
  requestKey?: string;
}

export class ClawBondInboxStore {
  private readonly stateRoot: string;
  private readonly updateChains = new Map<string, Promise<unknown>>();

  public constructor(stateRoot?: string) {
    this.stateRoot = resolveStateRoot(stateRoot);
  }

  public listPendingSync(accountId: string, limit = 10): ClawBondPendingInboxItem[] {
    return this.readItemsSync(accountId)
      .filter((item) => item.status === "pending")
      .slice(-Math.max(1, Math.trunc(limit)));
  }

  public countPendingSync(accountId: string): number {
    return this.readItemsSync(accountId).filter((item) => item.status === "pending").length;
  }

  public async listPending(accountId: string, limit = 10): Promise<ClawBondPendingInboxItem[]> {
    return (await this.readItems(accountId))
      .filter((item) => item.status === "pending")
      .slice(-Math.max(1, Math.trunc(limit)));
  }

  public async countPending(accountId: string): Promise<number> {
    return (await this.readItems(accountId)).filter((item) => item.status === "pending").length;
  }

  public listPendingByIdsSync(accountId: string, itemIds: string[]): ClawBondPendingInboxItem[] {
    const wanted = new Set(itemIds.map((item) => item.trim()).filter(Boolean));
    if (wanted.size === 0) {
      return [];
    }

    return this.readItemsSync(accountId).filter(
      (item) => item.status === "pending" && wanted.has(item.id)
    );
  }

  public async enqueue(
    accountId: string,
    input: EnqueueInboxItemInput
  ): Promise<{ created: boolean; merged: boolean; item: ClawBondPendingInboxItem }> {
    return this.update(accountId, (items) => {
      const existing = items.find((item) => item.fingerprint === input.fingerprint);
      if (existing) {
        return { items, created: false, merged: false, item: existing };
      }

      const mergeTarget = findPendingConversationMergeTarget(items, input);
      if (mergeTarget) {
        const merged = mergePendingConversationItem(mergeTarget, input);
        return {
          items: items.map((item) => (item.id === mergeTarget.id ? merged : item)),
          created: false,
          merged: true,
          item: merged
        };
      }

      const item: ClawBondPendingInboxItem = {
        id: randomUUID(),
        accountId,
        fingerprint: input.fingerprint.trim(),
        traceId: input.traceId.trim() || input.fingerprint.trim(),
        sourceKind: input.sourceKind,
        peerId: input.peerId.trim() || "unknown",
        peerLabel: input.peerLabel.trim() || input.peerId.trim() || "unknown",
        summary: input.summary.trim() || "ClawBond inbox item",
        content: input.content.trim(),
        receivedAt: normalizeTimestamp(input.receivedAt),
        deliveryPath: normalizeDeliveryPath(input.deliveryPath),
        status: "pending",
        requestId: normalizeOptionalString(input.requestId),
        conversationId: normalizeOptionalString(input.conversationId),
        notificationId: normalizeOptionalString(input.notificationId),
        requestKey: normalizeOptionalString(input.requestKey),
        wakeRequestedAt: null,
        wakeCount: 0,
        handledAt: null,
        handledBy: null,
        responsePreview: null
      };
      const nextItems = trimItems([...items, item]);
      return { items: nextItems, created: true, merged: false, item };
    });
  }

  public async markWakeRequested(accountId: string, itemIds: string[]): Promise<number> {
    const targetIds = new Set(itemIds.map((item) => item.trim()).filter(Boolean));
    if (targetIds.size === 0) {
      return 0;
    }

    const result = await this.update(accountId, (items) => {
      let updated = 0;
      const nextItems = items.map((item) => {
        if (!targetIds.has(item.id) || item.status !== "pending") {
          return item;
        }

        updated += 1;
        return {
          ...item,
          wakeRequestedAt: new Date().toISOString(),
          wakeCount: (item.wakeCount ?? 0) + 1
        };
      });
      return { items: nextItems, updated };
    });

    return result.updated ?? 0;
  }

  public async markHandledByConversation(
    accountId: string,
    conversationId: string,
    responsePreview?: string,
    handledBy: ClawBondInboxHandledBy = "clawbond_dm"
  ): Promise<ClawBondPendingInboxItem[]> {
    return this.markHandled(
      accountId,
      (item) => item.conversationId === conversationId.trim(),
      responsePreview,
      handledBy
    );
  }

  public async markLatestPendingByConversation(
    accountId: string,
    conversationId: string,
    responsePreview?: string,
    handledBy: ClawBondInboxHandledBy = "clawbond_dm",
    peerId?: string
  ): Promise<ClawBondPendingInboxItem[]> {
    const normalizedConversationId = conversationId.trim();
    const normalizedPeerId = normalizeOptionalString(peerId);
    if (!normalizedConversationId) {
      return [];
    }

    return this.update(accountId, (items) => {
      const candidates = items
        .map((item, index) => ({ item, index }))
        .filter(
          ({ item }) =>
            item.status === "pending" &&
            item.conversationId === normalizedConversationId &&
            (!normalizedPeerId || item.peerId === normalizedPeerId)
        );
      const latest = candidates.at(-1);
      if (!latest) {
        return { items, handled: [] as ClawBondPendingInboxItem[] };
      }

      const handled = applyHandledUpdate(
        latest.item,
        normalizeOptionalString(responsePreview),
        handledBy
      );
      const nextItems = items.slice();
      nextItems[latest.index] = handled;
      return { items: nextItems, handled: [handled] };
    }).then((result) => result.handled ?? []);
  }

  public async markHandledByPeer(
    accountId: string,
    peerId: string,
    responsePreview?: string,
    handledBy: ClawBondInboxHandledBy = "clawbond_dm"
  ): Promise<ClawBondPendingInboxItem[]> {
    return this.markHandled(
      accountId,
      (item) => item.peerId === peerId.trim(),
      responsePreview,
      handledBy
    );
  }

  public async markHandledByNotification(
    accountId: string,
    notificationId: string,
    responsePreview?: string,
    handledBy: ClawBondInboxHandledBy = "clawbond_notifications"
  ): Promise<ClawBondPendingInboxItem[]> {
    return this.markHandled(
      accountId,
      (item) => item.notificationId === notificationId.trim(),
      responsePreview,
      handledBy
    );
  }

  public async markHandledByRequest(
    accountId: string,
    requestKey: string,
    responsePreview?: string,
    handledBy: ClawBondInboxHandledBy = "clawbond_connection_requests"
  ): Promise<ClawBondPendingInboxItem[]> {
    return this.markHandled(
      accountId,
      (item) => item.requestKey === requestKey.trim(),
      responsePreview,
      handledBy
    );
  }

  public async markLatestPendingBySourceKind(
    accountId: string,
    sourceKind: ClawBondPendingInboxItem["sourceKind"],
    responsePreview?: string,
    handledBy: ClawBondInboxHandledBy = "clawbond_notifications"
  ): Promise<ClawBondPendingInboxItem[]> {
    return this.update(accountId, (items) => {
      const pending = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.status === "pending" && item.sourceKind === sourceKind);
      const latest = pending.at(-1);
      if (!latest) {
        return { items, handled: [] as ClawBondPendingInboxItem[] };
      }

      const handled = applyHandledUpdate(
        latest.item,
        normalizeOptionalString(responsePreview),
        handledBy
      );
      const nextItems = items.slice();
      nextItems[latest.index] = handled;
      return { items: nextItems, handled: [handled] };
    }).then((result) => result.handled ?? []);
  }

  public ensureDirSync() {
    mkdirSync(path.join(this.stateRoot, INBOX_DIRNAME), { recursive: true });
  }

  private async markHandled(
    accountId: string,
    matcher: (item: ClawBondPendingInboxItem) => boolean,
    responsePreview: string | undefined,
    handledBy: ClawBondInboxHandledBy
  ): Promise<ClawBondPendingInboxItem[]> {
    const normalizedPreview = normalizeOptionalString(responsePreview);
    const result = await this.update(accountId, (items) => {
      const handled: ClawBondPendingInboxItem[] = [];
      const nextItems = items.map((item) => {
        if (item.status !== "pending" || !matcher(item)) {
          return item;
        }

        const updated = applyHandledUpdate(item, normalizedPreview, handledBy);
        handled.push(updated);
        return updated;
      });
      return { items: nextItems, handled };
    });

    return result.handled ?? [];
  }

  private async update<T>(
    accountId: string,
    updater: (items: ClawBondPendingInboxItem[]) => {
      items: ClawBondPendingInboxItem[];
      created?: boolean;
      item?: ClawBondPendingInboxItem;
      updated?: number;
      handled?: ClawBondPendingInboxItem[];
    } & T
  ): Promise<
    {
      items: ClawBondPendingInboxItem[];
      created?: boolean;
      item?: ClawBondPendingInboxItem;
      updated?: number;
      handled?: ClawBondPendingInboxItem[];
    } & T
  > {
    return this.withAccountLock(accountId, async () => {
      const current = await this.readItems(accountId);
      const result = updater(current);
      await this.writeItems(accountId, result.items);
      return result;
    });
  }

  private async withAccountLock<T>(accountId: string, job: () => Promise<T>): Promise<T> {
    const key = accountId.trim() || "default";
    const previous = this.updateChains.get(key) ?? Promise.resolve();

    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => next);
    this.updateChains.set(key, chain);

    await previous;

    try {
      return await job();
    } finally {
      release();
      if (this.updateChains.get(key) === chain) {
        this.updateChains.delete(key);
      }
    }
  }

  private readItemsSync(accountId: string): ClawBondPendingInboxItem[] {
    const filePath = this.getFilePath(accountId);
    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      return normalizePendingInboxItems(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  private async readItems(accountId: string): Promise<ClawBondPendingInboxItem[]> {
    try {
      const raw = await readFile(this.getFilePath(accountId), "utf-8");
      return normalizePendingInboxItems(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  private async writeItems(accountId: string, items: ClawBondPendingInboxItem[]): Promise<void> {
    const filePath = this.getFilePath(accountId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(trimItems(items), null, 2)}\n`, "utf-8");
  }

  private getFilePath(accountId: string): string {
    return path.join(this.stateRoot, INBOX_DIRNAME, `${sanitizeFileSegment(accountId)}.json`);
  }
}

function normalizePendingInboxItems(value: unknown): ClawBondPendingInboxItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const id = normalizeOptionalString(candidate.id);
    const accountId = normalizeOptionalString(candidate.accountId);
    const fingerprint = normalizeOptionalString(candidate.fingerprint);
    const traceId = normalizeOptionalString(candidate.traceId) || fingerprint;
    const sourceKind = normalizeSourceKind(candidate.sourceKind);
    const peerId = normalizeOptionalString(candidate.peerId);
    const peerLabel = normalizeOptionalString(candidate.peerLabel) || peerId;
    const summary = normalizeOptionalString(candidate.summary);
    const content = normalizeOptionalString(candidate.content);
    if (!id || !accountId || !fingerprint || !traceId || !sourceKind || !peerId || !summary) {
      return [];
    }

    return [
      {
        id,
        accountId,
        fingerprint,
        traceId,
        sourceKind,
        peerId,
        peerLabel,
        summary,
        content,
        receivedAt: normalizeTimestamp(candidate.receivedAt),
        deliveryPath: normalizeDeliveryPath(candidate.deliveryPath),
        status: normalizeStatus(candidate.status),
        requestId: normalizeOptionalString(candidate.requestId),
        conversationId: normalizeOptionalString(candidate.conversationId),
        notificationId: normalizeOptionalString(candidate.notificationId),
        requestKey: normalizeOptionalString(candidate.requestKey),
        wakeRequestedAt: normalizeNullableTimestamp(candidate.wakeRequestedAt),
        wakeCount: normalizePositiveInteger(candidate.wakeCount),
        handledAt: normalizeNullableTimestamp(candidate.handledAt),
        handledBy: normalizeHandledBy(candidate.handledBy),
        responsePreview: normalizeOptionalString(candidate.responsePreview)
      }
    ];
  });
}

function trimItems(items: ClawBondPendingInboxItem[]): ClawBondPendingInboxItem[] {
  if (items.length <= MAX_STORED_ITEMS) {
    return items;
  }

  const pending = items.filter((item) => item.status === "pending");
  const handled = items.filter((item) => item.status === "handled");
  const remaining = Math.max(0, MAX_STORED_ITEMS - pending.length);
  return [...pending, ...handled.slice(-remaining)];
}

function applyHandledUpdate(
  item: ClawBondPendingInboxItem,
  responsePreview: string | undefined,
  handledBy: ClawBondInboxHandledBy
): ClawBondPendingInboxItem {
  return {
    ...item,
    status: "handled",
    handledAt: new Date().toISOString(),
    handledBy,
    responsePreview: responsePreview || item.responsePreview
  };
}

function findPendingConversationMergeTarget(
  items: ClawBondPendingInboxItem[],
  input: EnqueueInboxItemInput
): ClawBondPendingInboxItem | null {
  if (input.sourceKind !== "message") {
    return null;
  }

  const conversationId = normalizeOptionalString(input.conversationId);
  const peerId = normalizeOptionalString(input.peerId);
  if (!conversationId) {
    return null;
  }

  return (
    [...items]
      .reverse()
      .find(
        (item) =>
          item.status === "pending" &&
          item.sourceKind === "message" &&
          item.conversationId === conversationId &&
          (!peerId || item.peerId === peerId)
      ) ?? null
  );
}

function mergePendingConversationItem(
  existing: ClawBondPendingInboxItem,
  input: EnqueueInboxItemInput
): ClawBondPendingInboxItem {
  return {
    ...existing,
    fingerprint: input.fingerprint.trim() || existing.fingerprint,
    traceId: existing.traceId,
    peerId: input.peerId.trim() || existing.peerId,
    peerLabel: input.peerLabel.trim() || existing.peerLabel,
    summary: input.summary.trim() || existing.summary,
    content: mergePendingMessageContent(existing, input.content, input.receivedAt),
    receivedAt: normalizeTimestamp(input.receivedAt),
    deliveryPath: normalizeDeliveryPath(input.deliveryPath) || existing.deliveryPath,
    requestId: normalizeOptionalString(input.requestId) || existing.requestId,
    conversationId: normalizeOptionalString(input.conversationId) || existing.conversationId,
    notificationId: normalizeOptionalString(input.notificationId) || existing.notificationId,
    requestKey: normalizeOptionalString(input.requestKey) || existing.requestKey
  };
}

function mergePendingMessageContent(
  existing: ClawBondPendingInboxItem,
  nextContent: string,
  nextReceivedAt: string | undefined
): string {
  const currentSegments = readMergedMessageSegments(existing.content, existing.receivedAt);
  const nextSegment = formatMergedMessageSegment(nextContent, nextReceivedAt);
  if (!nextSegment) {
    return currentSegments.join(MERGED_MESSAGE_SEPARATOR);
  }

  if (currentSegments.at(-1) === nextSegment) {
    return currentSegments.join(MERGED_MESSAGE_SEPARATOR);
  }

  return [...currentSegments, nextSegment]
    .slice(-MAX_MERGED_MESSAGE_SEGMENTS)
    .join(MERGED_MESSAGE_SEPARATOR);
}

function readMergedMessageSegments(content: string, receivedAt: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.includes(MERGED_MESSAGE_SEPARATOR)) {
    return trimmed
      .split(MERGED_MESSAGE_SEPARATOR)
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  return [formatMergedMessageSegment(trimmed, receivedAt)].filter(Boolean);
}

function formatMergedMessageSegment(content: string, receivedAt: string | undefined): string {
  const trimmed = normalizeOptionalString(content) || "";
  if (!trimmed) {
    return "";
  }

  return `[${normalizeTimestamp(receivedAt)}] ${trimmed}`;
}

function normalizeSourceKind(value: unknown): ClawBondPendingInboxItem["sourceKind"] | null {
  return value === "message" ||
    value === "notification" ||
    value === "connection_request" ||
    value === "connection_request_response"
    ? value
    : null;
}

function normalizeStatus(value: unknown): ClawBondPendingInboxItemStatus {
  return value === "handled" ? "handled" : "pending";
}

function normalizeHandledBy(value: unknown): ClawBondInboxHandledBy | null {
  return value === "clawbond_dm" ||
    value === "clawbond_notifications" ||
    value === "clawbond_connection_requests" ||
    value === "manual"
    ? value
    : null;
}

function normalizeDeliveryPath(value: unknown): ClawBondDeliveryPath | undefined {
  return value === "platform_realtime" ||
    value === "notification_realtime" ||
    value === "notification_polling"
    ? value
    : undefined;
}

function normalizeTimestamp(value: unknown): string {
  const date = typeof value === "string" && value.trim() ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function normalizeNullableTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return normalizeTimestamp(value);
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-") || "default";
}
