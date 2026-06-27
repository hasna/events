import type { EventFilter, FieldMatcherValue } from "./types.js";

type MatcherValue = FieldMatcherValue | { not: FieldMatcherValue };

export interface FilterOptionInput {
  source?: string;
  type?: string;
  subject?: string;
  severity?: string;
  data?: string[];
  metadata?: string[];
  dataJson?: string[];
  metadataJson?: string[];
}

export function parseFieldMatchers(values: string[] | undefined, label: string, typed = false): Record<string, MatcherValue> | undefined {
  if (!values?.length) return undefined;
  const result: Record<string, MatcherValue> = {};
  for (const value of values) {
    const parsed = parseMatcherExpression(value, label);
    const path = parsed.path;
    if (path in result) throw new Error(`Duplicate ${label} filter path: ${path}`);
    const matcherValue = typed ? parseTypedMatcherValue(parsed.rawValue, label) : parsed.rawValue;
    result[path] = parsed.negated ? { not: matcherValue } : matcherValue;
  }
  return result;
}

export function parseFilterOptions(options: FilterOptionInput): EventFilter[] | undefined {
  const filter: EventFilter = {};
  if (options.source) filter.source = options.source;
  if (options.type) filter.type = options.type;
  if (options.subject) filter.subject = options.subject;
  if (options.severity) filter.severity = options.severity;
  const data = mergeMatchers(parseFieldMatchers(options.data, "data"), parseFieldMatchers(options.dataJson, "data-json", true));
  const metadata = mergeMatchers(parseFieldMatchers(options.metadata, "metadata"), parseFieldMatchers(options.metadataJson, "metadata-json", true));
  if (Object.keys(data).length > 0) filter.data = data;
  if (Object.keys(metadata).length > 0) filter.metadata = metadata;
  return Object.keys(filter).length > 0 ? [filter] : undefined;
}

function mergeMatchers(...records: Array<Record<string, MatcherValue> | undefined>): Record<string, MatcherValue> {
  const result: Record<string, MatcherValue> = {};
  for (const record of records) {
    if (!record) continue;
    for (const [path, value] of Object.entries(record)) {
      if (path in result) throw new Error(`Duplicate filter path: ${path}`);
      result[path] = value;
    }
  }
  return result;
}

function parseTypedMatcherValue(value: string, label: string): FieldMatcherValue {
  const parsed = JSON.parse(value);
  if (
    parsed === null ||
    typeof parsed === "string" ||
    typeof parsed === "number" ||
    typeof parsed === "boolean" ||
    (Array.isArray(parsed) && parsed.every((item) => typeof item === "string"))
  ) {
    return parsed;
  }
  throw new Error(`${label} filter JSON values must be string, string[], number, boolean, or null`);
}

function parseMatcherExpression(value: string, label: string): { path: string; rawValue: string; negated: boolean } {
  const negativeSeparator = value.indexOf("!=");
  if (negativeSeparator > 0) {
    return {
      path: value.slice(0, negativeSeparator),
      rawValue: value.slice(negativeSeparator + 2),
      negated: true,
    };
  }
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid ${label} filter, expected path=value or path!=value: ${value}`);
  return {
    path: value.slice(0, separator),
    rawValue: value.slice(separator + 1),
    negated: false,
  };
}
