import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { getClawBondRuntime } from "./runtime.ts";

const MAIN_SESSION_KEY = "agent:main:main";
export const CLAWBOND_MAIN_SESSION_ACTIVATION_MESSAGE = "ClawBond realtime handoff.";
const OPENCLAW_ENTRY_BASENAMES = new Set(["openclaw", "openclaw.mjs", "openclaw.js"]);
const OPENCLAW_ENTRY_SUFFIXES = ["/dist/entry.js", "/dist/entry.mjs"];

export type OpenClawSpawnTarget = {
  command: string;
  args: string[];
};

function resolveExplicitOpenClawCommand(explicitCommand?: string | null): string {
  return (
    explicitCommand?.trim() ||
    process.env.CLAWBOND_OPENCLAW_BIN?.trim() ||
    process.env.OPENCLAW_BIN?.trim() ||
    ""
  );
}

function resolveCurrentProcessOpenClawTarget(
  processExecPath?: string | null,
  processArgv1?: string | null
): OpenClawSpawnTarget | null {
  const execPath = processExecPath?.trim() || process.execPath?.trim() || "";
  const argv1 = processArgv1?.trim() || process.argv[1]?.trim() || "";
  if (!execPath || !argv1) {
    return null;
  }

  const entryBasename = path.basename(argv1).toLowerCase();
  if (OPENCLAW_ENTRY_BASENAMES.has(entryBasename)) {
    return {
      command: execPath,
      args: [argv1]
    };
  }

  const normalizedArgv1 = argv1.replace(/\\/g, "/").toLowerCase();
  if (OPENCLAW_ENTRY_SUFFIXES.some((suffix) => normalizedArgv1.endsWith(suffix))) {
    return {
      command: execPath,
      args: [argv1]
    };
  }

  return null;
}

export function resolveOpenClawSpawnTarget(options?: {
  explicitCommand?: string | null;
  processExecPath?: string | null;
  processArgv1?: string | null;
}): OpenClawSpawnTarget {
  const explicitCommand = resolveExplicitOpenClawCommand(options?.explicitCommand);
  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: []
    };
  }

  const currentProcessTarget = resolveCurrentProcessOpenClawTarget(
    options?.processExecPath,
    options?.processArgv1
  );
  if (currentProcessTarget) {
    return currentProcessTarget;
  }

  return {
    command: "openclaw",
    args: []
  };
}

export function resolveOpenClawCommand(): string {
  return resolveOpenClawSpawnTarget().command;
}

export function resolveOpenClawProfileArgs(): string[] {
  const explicitProfile = process.env.OPENCLAW_PROFILE?.trim();
  if (explicitProfile) {
    return explicitProfile === "dev" ? ["--dev"] : ["--profile", explicitProfile];
  }

  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    if (configPath.includes(`${path.sep}.openclaw-dev${path.sep}`)) {
      return ["--dev"];
    }

    const profileMatch = configPath.match(/\.openclaw-([^/\\]+)[/\\]openclaw\.json$/);
    if (profileMatch?.[1]) {
      return ["--profile", profileMatch[1]];
    }
  }

  return [];
}

export function spawnDetachedOpenClaw(args: string[], onError?: (error: unknown) => void) {
  const target = resolveOpenClawSpawnTarget();
  const child = spawn(target.command, [...target.args, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });

  if (onError) {
    child.on("error", onError);
  }

  child.unref();
  return child;
}

export function queueMainSessionVisibleNote(
  message: string,
  options?: {
    label?: string;
    sessionKey?: string;
    onError?: (error: unknown) => void;
  }
) {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  const params = JSON.stringify({
    sessionKey: options?.sessionKey?.trim() || MAIN_SESSION_KEY,
    message: trimmed,
    ...(options?.label?.trim() ? { label: options.label.trim() } : {})
  });

  spawnDetachedOpenClaw(
    [...resolveOpenClawProfileArgs(), "gateway", "call", "chat.inject", "--params", params],
    options?.onError
  );
}

export function queueMainSessionWakeEvent(
  message: string,
  options?: {
    sessionKey?: string;
    onError?: (error: unknown) => void;
  }
) {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  const sessionKey = options?.sessionKey?.trim() || MAIN_SESSION_KEY;
  let runtimeWakeFailed: unknown = null;

  try {
    const runtime = getClawBondRuntime();
    const enqueueSystemEvent = runtime.system?.enqueueSystemEvent;
    const requestHeartbeatNow = runtime.system?.requestHeartbeatNow;

    if (enqueueSystemEvent && requestHeartbeatNow) {
      enqueueSystemEvent(trimmed, {
        sessionKey,
        contextKey: "clawbond"
      });
      requestHeartbeatNow({
        reason: "hook:clawbond",
        coalesceMs: 0,
        sessionKey
      });
      return;
    }
  } catch (error) {
    runtimeWakeFailed = error;
  }

  spawnDetachedOpenClaw(
    [
      ...resolveOpenClawProfileArgs(),
      "system",
      "event",
      "--mode",
      "now",
      "--text",
      trimmed
    ],
    (error) => {
      if (runtimeWakeFailed) {
        options?.onError?.(
          new AggregateError(
            [runtimeWakeFailed, error],
            "ClawBond runtime wake failed and CLI fallback also failed"
          )
        );
        return;
      }

      options?.onError?.(error);
    }
  );
}

export function queueMainSessionChatSend(
  message: string,
  options?: {
    sessionKey?: string;
    idempotencyKey?: string;
    onError?: (error: unknown) => void;
  }
) {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  const params = JSON.stringify({
    sessionKey: options?.sessionKey?.trim() || MAIN_SESSION_KEY,
    message: trimmed,
    idempotencyKey:
      options?.idempotencyKey?.trim() || `clawbond-${Date.now()}-${randomUUID()}`
  });

  spawnDetachedOpenClaw(
    [...resolveOpenClawProfileArgs(), "gateway", "call", "chat.send", "--params", params],
    options?.onError
  );
}
