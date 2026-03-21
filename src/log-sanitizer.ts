const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /^(authorization|token|access[_-]?token|refresh[_-]?token|runtime[_-]?token|connector[_-]?token|secret|secret[_-]?key|api[_-]?key|password|cookie)$/i;

export function sanitizeLogString(value: string): string {
  let sanitized = value;

  sanitized = sanitized.replace(
    /\b(Bearer)\s+([A-Za-z0-9\-._~+/]+=*)/gi,
    `$1 ${REDACTED}`
  );
  sanitized = sanitized.replace(
    /([?&](?:[^=\s&#]*token|secret(?:[_-]?key)?|authorization|api[_-]?key|password|cookie)=)([^&#\s]+)/gi,
    `$1${REDACTED}`
  );
  sanitized = sanitized.replace(
    /((?:^|[{\s,])["']?(?:authorization|token|access[_-]?token|refresh[_-]?token|runtime[_-]?token|connector[_-]?token|secret(?:[_-]?key)?|api[_-]?key|password|cookie)["']?\s*[:=]\s*["'])([^"']*)(["'])/gi,
    (_match, prefix: string, _value: string, suffix: string) => `${prefix}${REDACTED}${suffix}`
  );
  sanitized = sanitized.replace(
    /((?:^|[{\s,])["']?(?:authorization|token|access[_-]?token|refresh[_-]?token|runtime[_-]?token|connector[_-]?token|secret(?:[_-]?key)?|api[_-]?key|password|cookie)["']?\s*[:=]\s*)([^"',}\s]+)/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`
  );

  return sanitized;
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitizeLogValueInternal(value, new WeakSet<object>());
}

function sanitizeLogValueInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizeLogString(value);
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValueInternal(entry, seen));
  }

  if (value instanceof Error) {
    return sanitizeLogString(value.message);
  }

  if (typeof value !== "object") {
    return sanitizeLogString(String(value));
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (isSensitiveKey(key) && entry !== undefined) {
      sanitized[key] = REDACTED;
      continue;
    }

    sanitized[key] = sanitizeLogValueInternal(entry, seen);
  }

  return sanitized;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
