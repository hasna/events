import type { ChannelConfig, DeliveryResult, EventEnvelope } from "../types.js";

export const DEFAULT_LIST_LIMIT = 20;

export interface Page<T> {
  rows: T[];
  total: number;
  shown: number;
  omittedBefore: number;
  omittedAfter: number;
  nextCursor?: string;
}

export interface ListHintOptions {
  beforeLabel?: string;
  afterLabel?: string;
  cursorLabel?: string;
}

export function parsePositiveInteger(value: string | number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolveHumanLimit(value: string | number | undefined): number {
  return parsePositiveInteger(value, "--limit") ?? DEFAULT_LIST_LIMIT;
}

export function truncate(value: unknown, maxLength = 80): string {
  if (value === undefined || value === null || value === "") return "-";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3)}...`;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => (
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
  ));
  return [headers, ...rows]
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd())
    .join("\n");
}

export function pageFromStart<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const pageRows = rows.slice(0, limit);
  return {
    rows: pageRows,
    total: rows.length,
    shown: pageRows.length,
    omittedBefore: 0,
    omittedAfter: Math.max(0, rows.length - pageRows.length),
  };
}

export function recentPage<T extends { id: string }>(rows: T[], limit: number, cursor?: string): Page<T> {
  if (cursor) {
    const cursorIndex = rows.findIndex((row) => row.id === cursor);
    if (cursorIndex === -1) throw new Error(`Cursor not found: ${cursor}`);
    const end = cursorIndex;
    const start = Math.max(0, end - limit);
    const pageRows = rows.slice(start, end);
    return {
      rows: pageRows,
      total: rows.length,
      shown: pageRows.length,
      omittedBefore: start,
      omittedAfter: Math.max(0, rows.length - end),
      nextCursor: start > 0 ? pageRows.at(0)?.id : undefined,
    };
  }

  const start = Math.max(0, rows.length - limit);
  const pageRows = rows.slice(start);
  return {
    rows: pageRows,
    total: rows.length,
    shown: pageRows.length,
    omittedBefore: start,
    omittedAfter: 0,
    nextCursor: start > 0 ? pageRows.at(0)?.id : undefined,
  };
}

export function formatChannelsTable(channels: ChannelConfig[], verbose: boolean): string {
  const headers = verbose
    ? ["ID", "STATE", "TRANSPORT", "TARGET", "FILTERS", "RETRY", "UPDATED"]
    : ["ID", "STATE", "TRANSPORT", "TARGET"];
  const rows = channels.map((channel) => {
    const base = [
      truncate(channel.id, 32),
      channel.enabled ? "enabled" : "disabled",
      channel.transport,
      truncate(channelTarget(channel), verbose ? 96 : 64),
    ];
    if (!verbose) return base;
    return [
      ...base,
      truncate(formatFilters(channel.filters), 48),
      truncate(formatRetry(channel.retry), 24),
      truncate(channel.updatedAt, 24),
    ];
  });
  return formatTable(headers, rows);
}

export function formatEventsTable(events: EventEnvelope[], verbose: boolean): string {
  const headers = verbose
    ? ["TIME", "ID", "SOURCE", "TYPE", "SEVERITY", "SUBJECT", "MESSAGE"]
    : ["TIME", "ID", "SOURCE", "TYPE", "SEVERITY"];
  const rows = events.map((event) => {
    const base = [
      truncate(event.time, 24),
      truncate(event.id, 36),
      truncate(event.source, 24),
      truncate(event.type, 32),
      event.severity,
    ];
    if (!verbose) return base;
    return [
      ...base,
      truncate(event.subject, 32),
      truncate(event.message, 72),
    ];
  });
  return formatTable(headers, rows);
}

export function formatDeliveriesTable(deliveries: DeliveryResult[]): string {
  return formatTable(
    ["TIME", "ID", "EVENT", "CHANNEL", "TRANSPORT", "STATUS", "ATTEMPTS"],
    deliveries.map((delivery) => [
      truncate(delivery.completedAt, 24),
      truncate(delivery.id, 36),
      truncate(delivery.eventId, 36),
      truncate(delivery.channelId, 32),
      delivery.transport,
      delivery.status,
      String(delivery.attempts.length),
    ]),
  );
}

export function channelTarget(channel: ChannelConfig): string {
  if (channel.webhook?.url) return channel.webhook.url;
  if (channel.command?.command) {
    const args = channel.command.args?.length ? ` ${channel.command.args.join(" ")}` : "";
    return `${channel.command.command}${args}`;
  }
  return channel.transport;
}

export function formatListHint(command: string, page: Page<{ id: string }>, detailCommand: string, options: ListHintOptions = {}): string {
  const parts = [`Showing ${page.shown} of ${page.total}.`];
  if (page.omittedBefore > 0) parts.push(`${page.omittedBefore} ${options.beforeLabel ?? "older"} omitted.`);
  if (page.omittedAfter > 0) parts.push(`${page.omittedAfter} ${options.afterLabel ?? "more"} omitted.`);
  if (page.nextCursor) parts.push(`Use --cursor ${page.nextCursor} ${options.cursorLabel ?? "for next page"}.`);
  parts.push(`Use --limit <n>, --verbose, ${detailCommand}, or ${command} --json for more.`);
  return parts.join(" ");
}

export function formatSummaryHint(command: string, detailCommand: string): string {
  return `Use --verbose, ${detailCommand}, or ${command} --json for details.`;
}

function formatFilters(filters: ChannelConfig["filters"]): string {
  if (!filters?.length) return "all";
  return filters.map((filter) => (
    Object.entries(filter).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`).join(",")
  )).join(";");
}

function formatRetry(retry: ChannelConfig["retry"]): string {
  if (!retry) return "none";
  const parts = [];
  if (retry.maxAttempts !== undefined) parts.push(`${retry.maxAttempts} attempts`);
  if (retry.backoffMs !== undefined) parts.push(`${retry.backoffMs}ms`);
  if (retry.multiplier !== undefined) parts.push(`x${retry.multiplier}`);
  return parts.join(" ") || "custom";
}
