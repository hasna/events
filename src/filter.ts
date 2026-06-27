import type { ChannelConfig, EventEnvelope, EventFilter, FieldMatcher, FieldMatcherValue, NegativeFieldMatcher, StringMatcher } from "./types.js";

function getPathValue(input: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (value && typeof value === "object" && part in value) {
      return (value as Record<string, unknown>)[part];
    }
    return undefined;
  }, input);
}

function getFieldValues(input: Record<string, unknown>, path: string): unknown[] {
  const values: unknown[] = [];
  const push = (value: unknown) => {
    if (!values.some((item) => Object.is(item, value))) values.push(value);
  };

  if (path.includes(".") && path in input) push(input[path]);

  const nestedValue = getPathValue(input, path);
  if (nestedValue !== undefined || !path.includes(".")) push(nestedValue);

  return values;
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
  matcher: Record<string, FieldMatcher> | undefined,
): boolean {
  if (!matcher) return true;
  return Object.entries(matcher).every(([path, expected]) => {
    const actualValues = getFieldValues(input, path);
    return matchField(actualValues, expected, path);
  });
}

function matchField(actualValues: unknown[], expected: FieldMatcher, path: string): boolean {
  if (isNegativeMatcher(expected)) {
    return !actualValues.some((actual) => matchPositiveField(actual, expected.not, path));
  }
  return actualValues.some((actual) => matchPositiveField(actual, expected, path));
}

function matchPositiveField(actual: unknown, expected: FieldMatcherValue, path: string): boolean {
  if (typeof expected === "string" || Array.isArray(expected)) {
    return stringCandidates(actual).some((candidate) => matchString(candidate, expected, {
      segmentSafe: path.endsWith("_path") || path.endsWith(".path"),
    }));
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => item === expected);
  }
  return actual === expected;
}

function stringCandidates(actual: unknown): string[] {
  if (actual === undefined) return [];
  if (Array.isArray(actual)) {
    return actual.flatMap((item) => isPrimitiveFieldValue(item) ? [String(item)] : []);
  }
  return [String(actual)];
}

function isPrimitiveFieldValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isNegativeMatcher(value: FieldMatcher): value is NegativeFieldMatcher {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "not" in value);
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
