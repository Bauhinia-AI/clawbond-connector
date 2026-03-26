import type {
  AgentToolResult,
  OpenClawPluginToolContext
} from "openclaw/plugin-sdk/compat";

export class ToolInputError extends Error {
  public readonly status = 400;
}

export class ToolAuthorizationError extends Error {
  public readonly status = 403;
}

export function jsonToolResult(summary: string, details: unknown): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: `${summary}\n\n${JSON.stringify(details, null, 2)}`
      }
    ],
    details
  };
}

export function textToolResult(summary: string, details: unknown = { summary }): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: summary
      }
    ],
    details
  };
}

export function readRequiredString(
  params: Record<string, unknown>,
  key: string,
  label = key
): string {
  const value = readOptionalString(params, key, label);
  if (!value) {
    throw new ToolInputError(`Missing required field: ${label}`);
  }

  return value;
}

export function readOptionalString(
  params: Record<string, unknown>,
  key: string,
  label = key
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ToolInputError(`${label} must be a string`);
  }

  const normalized = value.trim();
  return normalized || undefined;
}

export function readOptionalBoolean(
  params: Record<string, unknown>,
  key: string,
  label = key
): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ToolInputError(`${label} must be a boolean`);
  }

  return value;
}

export function readOptionalNumber(
  params: Record<string, unknown>,
  key: string,
  label = key
): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`${label} must be a number`);
  }

  return value;
}

export function readOptionalRecord(
  params: Record<string, unknown>,
  key: string,
  label = key
): Record<string, unknown> | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

export function ensureToolAccess(
  ctx: OpenClawPluginToolContext,
  operation: string,
  mode: "read" | "write" = "read",
  _accountId?: string | null
) {
  if (!ctx.requesterSenderId) {
    return;
  }

  if (ctx.senderIsOwner === true) {
    return;
  }

  if (ctx.messageChannel === "clawbond") {
    return;
  }

  throw new ToolAuthorizationError(
    `Not allowed to ${mode} ClawBond data for ${operation} from non-owner sender`
  );
}

export function ensureOwnerOnlyToolAccess(
  ctx: OpenClawPluginToolContext,
  operation: string,
  mode: "read" | "write" = "write",
  _accountId?: string | null
) {
  if (!ctx.requesterSenderId) {
    return;
  }

  if (ctx.senderIsOwner === true) {
    return;
  }

  if (ctx.messageChannel === "clawbond") {
    return;
  }

  throw new ToolAuthorizationError(
    `Not allowed to ${mode} owner-only ClawBond action for ${operation} from non-owner sender`
  );
}

export function clampLimit(limit: number | undefined, fallback: number, max = 100): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }

  return Math.max(1, Math.min(max, Math.trunc(limit)));
}
