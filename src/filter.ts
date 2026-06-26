import type { ChannelConfig, EventEnvelope, EventFilter, StringMatcher } from "./types.js";

function getPathValue(input: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (value && typeof value === "object" && part in value) {
      return (value as Record<string, unknown>)[part];
    }
    return undefined;
  }, input);
}

function wildcardToRegExp(pattern: string, options: { segmentSafe?: boolean } = {}): RegExp {
  let body = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        body += ".*";
        index += 1;
      } else {
        body += options.segmentSafe ? "[^/]*" : ".*";
      }
    } else {
      body += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${body}$`);
}

export function matchString(value: string | undefined, matcher: StringMatcher | undefined, options: { segmentSafe?: boolean } = {}): boolean {
  if (matcher === undefined) return true;
  if (value === undefined) return false;
  const matchers = Array.isArray(matcher) ? matcher : [matcher];
  return matchers.some((item) => wildcardToRegExp(item, options).test(value));
}

function matchRecord(
  input: Record<string, unknown>,
  matcher: Record<string, StringMatcher | number | boolean | null> | undefined,
): boolean {
  if (!matcher) return true;
  return Object.entries(matcher).every(([path, expected]) => {
    const actual = getPathValue(input, path);
    if (typeof expected === "string" || Array.isArray(expected)) {
      return matchString(actual === undefined ? undefined : String(actual), expected, {
        segmentSafe: path.endsWith("_path") || path.endsWith(".path"),
      });
    }
    return actual === expected;
  });
}

export function eventMatchesFilter(event: EventEnvelope, filter: EventFilter): boolean {
  return (
    matchString(event.source, filter.source) &&
    matchString(event.type, filter.type) &&
    matchString(event.subject, filter.subject) &&
    matchString(event.severity, filter.severity) &&
    matchRecord(event.data, filter.data) &&
    matchRecord(event.metadata, filter.metadata)
  );
}

export function channelMatchesEvent(channel: ChannelConfig, event: EventEnvelope): boolean {
  if (!channel.enabled) return false;
  if (!channel.filters || channel.filters.length === 0) return true;
  return channel.filters.some((filter) => eventMatchesFilter(event, filter));
}
