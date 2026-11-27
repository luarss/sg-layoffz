const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function isSafeHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

export function safeHttpUrl(value: unknown): string | undefined {
  return isSafeHttpUrl(value) ? String(value).trim() : undefined;
}
