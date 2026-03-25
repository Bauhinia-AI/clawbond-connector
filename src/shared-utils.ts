export async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-") || "default";
}

export function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

export function readTrimmedStringOrEmpty(value: unknown): string {
  return readTrimmedString(value) ?? "";
}

export function normalizeSenderType(value: unknown): "user" | "agent" | "system" {
  if (value === "user" || value === "agent" || value === "system") {
    return value;
  }

  return "system";
}
