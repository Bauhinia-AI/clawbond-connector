import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ClawBondStoredAgent,
  ClawBondStoredCredentials,
  ClawBondSyncState,
  ClawBondUserSettings
} from "./types.ts";

const DEFAULT_STATE_ROOT = path.join(os.homedir(), ".clawbond");
const DEFAULT_USER_SETTINGS: ClawBondUserSettings = {
  dm_delivery_preference: "immediate",
  dm_round_limit: 10,
  heartbeat_enabled: false,
  heartbeat_interval_minutes: 10,
  heartbeat_direction_weights: {
    claw_evolution: 25,
    openclaw_skills: 25,
    hotspot_curation: 25,
    social_exploration: 25
  }
};
const DEFAULT_SYNC_STATE: ClawBondSyncState = {
  last_seen_dm_cursor: null,
  heartbeat_last_run_at: null
};

export class CredentialStore {
  private readonly stateRoot: string;

  public constructor(stateRoot?: string) {
    this.stateRoot = resolveStateRoot(stateRoot);
  }

  public getStateRoot(): string {
    return this.stateRoot;
  }

  public getAgentHomeSync(accountId: string): string | null {
    const stored = this.loadSync(accountId);
    return stored ? this.getAgentDir(stored.agentKey) : null;
  }

  public loadUserSettingsSync(accountId: string): ClawBondUserSettings {
    return normalizeUserSettings(
      this.readAgentJsonSync(accountId, "user-settings.json")
    );
  }

  public async saveUserSettings(
    accountId: string,
    settings: ClawBondUserSettings
  ): Promise<boolean> {
    const agentHome = this.getAgentHomeSync(accountId);
    if (!agentHome) {
      return false;
    }

    await mkdir(agentHome, { recursive: true });
    await writeFile(
      path.join(agentHome, "user-settings.json"),
      `${JSON.stringify(normalizeUserSettings(settings), null, 2)}\n`,
      "utf-8"
    );
    return true;
  }

  public loadSyncStateSync(accountId: string): ClawBondSyncState {
    return normalizeSyncState(this.readAgentJsonSync(accountId, "state.json"));
  }

  public async saveSyncState(accountId: string, state: ClawBondSyncState): Promise<boolean> {
    const agentHome = this.getAgentHomeSync(accountId);
    if (!agentHome) {
      return false;
    }

    await mkdir(agentHome, { recursive: true });
    await writeFile(
      path.join(agentHome, "state.json"),
      `${JSON.stringify(normalizeSyncState(state), null, 2)}\n`,
      "utf-8"
    );
    return true;
  }

  public loadSync(accountId: string): ClawBondStoredAgent | null {
    const pointer = this.readAccountPointerSync(accountId);
    if (pointer) {
      return this.readAgentSync(pointer);
    }

    const fallback = this.readSingleAgentSync();
    if (fallback) {
      this.writeAccountPointerSync(accountId, fallback.agentKey);
      this.writeActiveAgentPointerSync(fallback.agentKey);
      return fallback;
    }

    return null;
  }

  public async save(accountId: string, credentials: ClawBondStoredCredentials): Promise<ClawBondStoredAgent> {
    const agentKey = buildAgentKey(credentials.agent_name, credentials.agent_id);
    const agentDir = this.getAgentDir(agentKey);
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "credentials.json"),
      `${JSON.stringify(credentials, null, 2)}\n`,
      "utf-8"
    );

    await this.writeAccountPointer(accountId, agentKey);
    await this.writeActiveAgentPointer(agentKey);
    await this.ensureAgentHomeScaffold(agentDir);

    return { agentKey, credentials };
  }

  private readAccountPointerSync(accountId: string): string | null {
    const pointerPath = this.getPointerPath(accountId);
    if (!existsSync(pointerPath)) {
      return null;
    }

    try {
      const raw = JSON.parse(readFileSync(pointerPath, "utf-8")) as { agent_key?: unknown };
      return typeof raw.agent_key === "string" && raw.agent_key.trim() ? raw.agent_key.trim() : null;
    } catch {
      return null;
    }
  }

  private writeAccountPointerSync(accountId: string, agentKey: string) {
    const pointerPath = this.getPointerPath(accountId);
    mkdirSync(path.dirname(pointerPath), { recursive: true });
    writeFileSync(pointerPath, `${JSON.stringify({ agent_key: agentKey }, null, 2)}\n`, "utf-8");
  }

  private writeActiveAgentPointerSync(agentKey: string) {
    const pointerPath = this.getActiveAgentPointerPath();
    mkdirSync(path.dirname(pointerPath), { recursive: true });
    writeFileSync(pointerPath, `${JSON.stringify({ agent_key: agentKey }, null, 2)}\n`, "utf-8");
  }

  private async writeAccountPointer(accountId: string, agentKey: string): Promise<void> {
    const pointerPath = this.getPointerPath(accountId);
    await mkdir(path.dirname(pointerPath), { recursive: true });
    await writeFile(pointerPath, `${JSON.stringify({ agent_key: agentKey }, null, 2)}\n`, "utf-8");
  }

  private async writeActiveAgentPointer(agentKey: string): Promise<void> {
    const pointerPath = this.getActiveAgentPointerPath();
    await mkdir(path.dirname(pointerPath), { recursive: true });
    await writeFile(pointerPath, `${JSON.stringify({ agent_key: agentKey }, null, 2)}\n`, "utf-8");
  }

  private readSingleAgentSync(): ClawBondStoredAgent | null {
    const agentsDir = path.join(this.stateRoot, "agents");
    if (!existsSync(agentsDir)) {
      return null;
    }

    const entries = readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (entries.length !== 1) {
      return null;
    }

    return this.readAgentSync(entries[0]!.name);
  }

  private readAgentSync(agentKey: string): ClawBondStoredAgent | null {
    const credentialsPath = path.join(this.getAgentDir(agentKey), "credentials.json");
    if (!existsSync(credentialsPath)) {
      return null;
    }

    try {
      const raw = JSON.parse(readFileSync(credentialsPath, "utf-8")) as ClawBondStoredCredentials;
      if (!isStoredCredentials(raw)) {
        return null;
      }

      return { agentKey, credentials: raw };
    } catch {
      return null;
    }
  }

  private getPointerPath(accountId: string): string {
    return path.join(this.stateRoot, "accounts", `${sanitizeFileSegment(accountId)}.json`);
  }

  private getActiveAgentPointerPath(): string {
    return path.join(this.stateRoot, "active-agent.json");
  }

  private getAgentDir(agentKey: string): string {
    return path.join(this.stateRoot, "agents", agentKey);
  }

  private readAgentJsonSync(accountId: string, filename: string): unknown {
    const agentHome = this.getAgentHomeSync(accountId);
    if (!agentHome) {
      return null;
    }

    const filePath = path.join(agentHome, filename);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    } catch {
      return null;
    }
  }

  private async ensureAgentHomeScaffold(agentDir: string): Promise<void> {
    await mkdir(path.join(agentDir, "reports"), { recursive: true });
    await ensureJsonFile(path.join(agentDir, "user-settings.json"), DEFAULT_USER_SETTINGS);
    await ensureJsonFile(path.join(agentDir, "state.json"), DEFAULT_SYNC_STATE);
  }
}

export function resolveStateRoot(value: string | undefined): string {
  if (!value?.trim()) {
    return DEFAULT_STATE_ROOT;
  }

  const trimmed = value.trim();
  if (trimmed === "~") {
    return os.homedir();
  }

  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return path.resolve(trimmed);
}

export function buildAgentKey(agentName: string, agentId: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "agent";
  const suffix = agentId.slice(-6) || agentId;
  return `${slug}-${suffix}`;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-") || "default";
}

function isStoredCredentials(value: unknown): value is ClawBondStoredCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.platform_base_url === "string" &&
    typeof candidate.agent_access_token === "string" &&
    typeof candidate.agent_id === "string" &&
    typeof candidate.agent_name === "string" &&
    typeof candidate.secret_key === "string" &&
    (candidate.binding_status === "pending" || candidate.binding_status === "bound")
  );
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function ensureJsonFile(filePath: string, data: unknown): Promise<void> {
  if (existsSync(filePath)) {
    return;
  }

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function getDefaultUserSettings(): ClawBondUserSettings {
  return JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS)) as ClawBondUserSettings;
}

export function getDefaultSyncState(): ClawBondSyncState {
  return { ...DEFAULT_SYNC_STATE };
}

export function normalizeUserSettings(value: unknown): ClawBondUserSettings {
  const defaults = getDefaultUserSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  const dmDeliveryPreference = candidate.dm_delivery_preference;

  return {
    dm_delivery_preference:
      dmDeliveryPreference === "immediate" ||
      dmDeliveryPreference === "next_chat" ||
      dmDeliveryPreference === "silent"
        ? dmDeliveryPreference
        : defaults.dm_delivery_preference,
    dm_round_limit: normalizePositiveInteger(candidate.dm_round_limit, defaults.dm_round_limit),
    heartbeat_enabled:
      typeof candidate.heartbeat_enabled === "boolean"
        ? candidate.heartbeat_enabled
        : defaults.heartbeat_enabled,
    heartbeat_interval_minutes: normalizePositiveInteger(
      candidate.heartbeat_interval_minutes,
      defaults.heartbeat_interval_minutes
    ),
    heartbeat_direction_weights: normalizeDirectionWeights(candidate.heartbeat_direction_weights)
  };
}

export function normalizeSyncState(value: unknown): ClawBondSyncState {
  const defaults = getDefaultSyncState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    last_seen_dm_cursor:
      typeof candidate.last_seen_dm_cursor === "string" && candidate.last_seen_dm_cursor.trim()
        ? candidate.last_seen_dm_cursor.trim()
        : null,
    heartbeat_last_run_at:
      typeof candidate.heartbeat_last_run_at === "string" && candidate.heartbeat_last_run_at.trim()
        ? candidate.heartbeat_last_run_at.trim()
        : defaults.heartbeat_last_run_at
  };
}

function normalizeDirectionWeights(value: unknown): ClawBondUserSettings["heartbeat_direction_weights"] {
  const defaults = getDefaultUserSettings().heartbeat_direction_weights;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    claw_evolution: normalizeNonNegativeInteger(candidate.claw_evolution, defaults.claw_evolution),
    openclaw_skills: normalizeNonNegativeInteger(candidate.openclaw_skills, defaults.openclaw_skills),
    hotspot_curation: normalizeNonNegativeInteger(candidate.hotspot_curation, defaults.hotspot_curation),
    social_exploration: normalizeNonNegativeInteger(
      candidate.social_exploration,
      defaults.social_exploration
    )
  };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}
