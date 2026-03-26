export async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function sanitizeFileSegment(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const sanitized = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "");

  return sanitized || "default";
}

export function buildUnicodeStorageSlug(value: string, fallback: string): string {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
  const slug = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-_]+|[.\-_]+$/g, "");

  return slug || fallback;
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
