import type {
  ClawBondAccount,
  ClawBondPlatformSocketMessageInbound,
  ClawBondStructuredMessageEnvelope
} from "./types.ts";

export const DEFAULT_STRUCTURED_MESSAGE_PREFIX = "[CLAWBOND_EVENT]";
const MAX_PAYLOAD_PREVIEW_CHARS = 4000;

export function normalizeTrustedSenderAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const deduped = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const normalized = item.trim();
    if (!normalized) {
      continue;
    }

    deduped.add(normalized);
  }

  return [...deduped];
}

export function normalizeStructuredMessagePrefix(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_STRUCTURED_MESSAGE_PREFIX;
  }

  const normalized = value.trim();
  return normalized || DEFAULT_STRUCTURED_MESSAGE_PREFIX;
}

export function resolveStructuredIncomingPrompt(
  account: Pick<ClawBondAccount, "structuredMessagePrefix" | "trustedSenderAgentIds">,
  payload: ClawBondPlatformSocketMessageInbound
): {
  prompt: string;
  structuredEnvelope?: ClawBondStructuredMessageEnvelope;
} {
  const envelope = parseStructuredMessageEnvelope(
    payload.content,
    account.structuredMessagePrefix,
    payload.from_agent_id,
    account.trustedSenderAgentIds
  );

  if (!envelope) {
    return {
      prompt: payload.content
    };
  }

  return {
    prompt: formatStructuredEnvelopeForAgent(payload.from_agent_id, envelope),
    structuredEnvelope: envelope
  };
}

export function parseStructuredMessageEnvelope(
  rawContent: string,
  prefix: string,
  senderAgentId: string,
  trustedSenderAgentIds: string[]
): ClawBondStructuredMessageEnvelope | null {
  if (!trustedSenderAgentIds.includes(senderAgentId)) {
    return null;
  }

  const trimmed = rawContent.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const jsonText = trimmed.slice(prefix.length).trim();
  if (!jsonText) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const kind =
    readNonEmptyString(candidate.type) ??
    readNonEmptyString(candidate.kind) ??
    "platform.message";

  return {
    kind,
    schema:
      typeof candidate.schema === "number" && Number.isFinite(candidate.schema)
        ? candidate.schema
        : undefined,
    taskId: readNonEmptyString(candidate.taskId),
    title: readNonEmptyString(candidate.title),
    summary: readNonEmptyString(candidate.summary),
    body: readNonEmptyString(candidate.body),
    payload: candidate.payload
  };
}

export function formatStructuredEnvelopeForAgent(
  senderAgentId: string,
  envelope: ClawBondStructuredMessageEnvelope
): string {
  const lines = [
    "ClawBond platform event",
    `Sender: agent:${senderAgentId}`,
    `Type: ${envelope.kind}`
  ];

  if (envelope.taskId) {
    lines.push(`Task ID: ${envelope.taskId}`);
  }

  if (envelope.title) {
    lines.push(`Title: ${envelope.title}`);
  }

  if (envelope.summary) {
    lines.push(`Summary: ${envelope.summary}`);
  }

  if (envelope.body) {
    lines.push("", "Instructions:", envelope.body);
  }

  const payloadPreview = formatPayloadPreview(envelope.payload);
  if (payloadPreview) {
    lines.push("", "Payload JSON:", payloadPreview);
  }

  return lines.join("\n");
}

function formatPayloadPreview(payload: unknown): string | null {
  if (payload === undefined) {
    return null;
  }

  if (typeof payload === "string") {
    const normalized = payload.trim();
    return normalized || null;
  }

  try {
    const serialized = JSON.stringify(payload, null, 2);
    if (!serialized) {
      return null;
    }

    if (serialized.length <= MAX_PAYLOAD_PREVIEW_CHARS) {
      return serialized;
    }

    return `${serialized.slice(0, MAX_PAYLOAD_PREVIEW_CHARS)}...`;
  } catch {
    const fallback = String(payload).trim();
    return fallback || null;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}
