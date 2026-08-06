import type { EventEnvelope } from "./types.js";

export function redactPaths<T extends EventEnvelope>(event: T, paths: string[], replacement = "[REDACTED]"): T {
  if (paths.length === 0) return event;
  const copy = structuredClone(event);
  for (const path of paths) {
    setPath(copy as unknown as Record<string, unknown>, path, replacement);
  }
  return copy;
}

export function redactSensitiveKeys<T extends EventEnvelope>(event: T, replacement = "[REDACTED]"): T {
  return redactValue(event, replacement) as T;
}

export function shouldRedactKey(key: string): boolean {
  return /secret|token|password|api[_-]?key|authorization/i.test(key);
}

function redactValue(value: unknown, replacement: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, replacement));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      shouldRedactKey(key) ? replacement : redactValue(item, replacement),
    ]),
  );
}

function setPath(input: Record<string, unknown>, path: string, replacement: string): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = input;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object") return;
    cursor = next as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last && last in cursor) cursor[last] = replacement;
}
