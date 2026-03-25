import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveStateRoot } from "./credential-store.ts";
import { sanitizeFileSegment } from "./shared-utils.ts";
import type { ClawBondActivityEntry } from "./types.ts";

const ACTIVITY_DIRNAME = "activity";
const MAX_ACTIVITY_ENTRIES = 1000;
const MAX_ACTIVITY_FILE_BYTES = 512 * 1024;
const activityUpdateChains = new Map<string, Promise<unknown>>();

export class ClawBondActivityStore {
  private readonly stateRoot: string;

  public constructor(stateRoot?: string) {
    this.stateRoot = resolveStateRoot(stateRoot);
  }

  public async append(
    accountId: string,
    entry: Omit<ClawBondActivityEntry, "id" | "recordedAt" | "accountId"> &
      Partial<Pick<ClawBondActivityEntry, "id" | "recordedAt">>
  ): Promise<ClawBondActivityEntry> {
    const normalized: ClawBondActivityEntry = {
      ...entry,
      id: entry.id?.trim() || randomUUID(),
      recordedAt: normalizeTimestamp(entry.recordedAt),
      accountId
    };

    const filePath = this.getFilePath(accountId);
    await this.withAccountLock(accountId, async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(normalized)}\n`, "utf-8");
      await this.compactIfNeeded(filePath);
    });
    return normalized;
  }

  public listSync(accountId: string, limit = 100): ClawBondActivityEntry[] {
    return this.parseEntries(readFileTextSync(this.getFilePath(accountId)), limit);
  }

  public async list(accountId: string, limit = 100): Promise<ClawBondActivityEntry[]> {
    return this.parseEntries(await readFileText(this.getFilePath(accountId)), limit);
  }

  public ensureDirSync() {
    mkdirSync(path.join(this.stateRoot, ACTIVITY_DIRNAME), { recursive: true });
  }

  private getFilePath(accountId: string): string {
    return path.join(this.stateRoot, ACTIVITY_DIRNAME, `${sanitizeFileSegment(accountId)}.jsonl`);
  }

  private async compactIfNeeded(filePath: string): Promise<void> {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }

    if (fileStat.size <= MAX_ACTIVITY_FILE_BYTES) {
      return;
    }

    const raw = await readFileText(filePath);
    const entries = this.parseEntries(raw, 0);
    if (entries.length <= MAX_ACTIVITY_ENTRIES && fileStat.size <= MAX_ACTIVITY_FILE_BYTES) {
      return;
    }

    const compacted = entries
      .slice(-MAX_ACTIVITY_ENTRIES)
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const nextRaw = compacted ? `${compacted}\n` : "";
    const tempPath = `${filePath}.tmp`;
    await writeFile(tempPath, nextRaw, "utf-8");
    await rename(tempPath, filePath);
  }

  private async withAccountLock<T>(accountId: string, job: () => Promise<T>): Promise<T> {
    const key = `${this.stateRoot}::${accountId.trim() || "default"}`;
    const previous = activityUpdateChains.get(key) ?? Promise.resolve();

    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => next);
    activityUpdateChains.set(key, chain);

    await previous;

    try {
      return await job();
    } finally {
      release();
      if (activityUpdateChains.get(key) === chain) {
        activityUpdateChains.delete(key);
      }
    }
  }

  private parseEntries(raw: string | null, limit: number): ClawBondActivityEntry[] {
    if (!raw?.trim()) {
      return [];
    }

    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isActivityEntry(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });

    if (!Number.isFinite(limit) || limit <= 0) {
      return entries;
    }

    return entries.slice(-Math.trunc(limit));
  }
}

function readFileTextSync(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function readFileText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: string | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function isActivityEntry(value: unknown): value is ClawBondActivityEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.recordedAt === "string" &&
    typeof candidate.accountId === "string" &&
    typeof candidate.agentId === "string" &&
    typeof candidate.sessionKey === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.event === "string"
  );
}
