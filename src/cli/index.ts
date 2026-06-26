#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventsClient, JsonEventsStore, getEventsDataDir, getEventsStatus, sanitizeChannelForOutput, sanitizeChannelsForOutput, type ChannelConfig, type EventFilter, type TransportKind } from "../index.js";
import { parseFilterOptions } from "../filter-options.js";

interface ParsedArgs {
  json: boolean;
  dir?: string;
  rest: string[];
}

export interface RunEventsCliOptions {
  programName?: string;
  source?: string;
}

function version(): string {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(packagePath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseGlobalArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let json = false;
  let dir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json" || arg === "-j") {
      json = true;
    } else if (arg === "--dir") {
      dir = argv[++index];
    } else {
      rest.push(arg);
    }
  }
  return { json, dir, rest };
}

function takeOption(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  const equalsIndex = args.findIndex((arg) => arg.startsWith(equalsPrefix));
  if (equalsIndex !== -1) {
    const value = args[equalsIndex]?.slice(equalsPrefix.length);
    args.splice(equalsIndex, 1);
    return value;
  }

  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeMany(args: string[], name: string): string[] {
  const values: string[] = [];
  while (args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`))) {
    const value = takeOption(args, name);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function parseJsonOption(value: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!value) return fallback;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseFilter(args: string[]): EventFilter[] | undefined {
  return parseFilterOptions({
    type: takeOption(args, "--type") ?? takeOption(args, "--event-type"),
    source: takeOption(args, "--source"),
    subject: takeOption(args, "--subject"),
    severity: takeOption(args, "--severity"),
    data: takeMany(args, "--data"),
    metadata: takeMany(args, "--metadata"),
    dataJson: takeMany(args, "--data-json"),
    metadataJson: takeMany(args, "--metadata-json"),
  });
}

function parseHeaders(values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) throw new Error(`Invalid header, expected name=value: ${value}`);
    headers[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return headers;
}

function output(parsed: ParsedArgs, value: unknown, human: () => void): void {
  if (parsed.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  human();
}

function commandName(options: RunEventsCliOptions): string {
  return options.programName ?? "events";
}

function printHelp(options: RunEventsCliOptions = {}): void {
  const name = commandName(options);
  console.log(`${name} ${version()}

Usage:
  ${name} [--dir <path>] [--json] webhooks add <url|command> [options]
  ${name} [--dir <path>] [--json] webhooks list
  ${name} [--dir <path>] [--json] webhooks remove <id>
  ${name} [--dir <path>] [--json] webhooks test <id>
  ${name} [--dir <path>] [--json] webhooks match <id>
  ${name} [--dir <path>] [--json] webhooks status
  ${name} [--dir <path>] [--json] status
  ${name} [--dir <path>] [--json] events emit <type>${options.source ? "" : " --source <source>"} [options]
  ${name} [--dir <path>] [--json] events list [--limit <n>]
  ${name} [--dir <path>] [--json] events replay [--id <event-id>] [--dry-run]

Environment:
  HASNA_EVENTS_DIR or HASNA_EVENTS_HOME overrides the default ${getEventsDataDir()}`);
}

function printWebhooksHelp(options: RunEventsCliOptions = {}): void {
  const name = commandName(options);
  console.log(`${name} webhooks

Usage:
  ${name} [--dir <path>] [--json] webhooks add <url|command> [options]
  ${name} [--dir <path>] [--json] webhooks list
  ${name} [--dir <path>] [--json] webhooks remove <id>
  ${name} [--dir <path>] [--json] webhooks test <id>
  ${name} [--dir <path>] [--json] webhooks match <id>
  ${name} [--dir <path>] [--json] webhooks status

Options:
  --id <id>                 Channel id for add
  --type <pattern>          Event type filter, supports wildcards
  --source <source>         Event source filter
  --subject <subject>       Event subject filter
  --severity <severity>     Event severity filter
  --data <path=value>       Event data field filter, repeatable; string values, dot paths, * segment wildcard, ** recursive wildcard
  --metadata <path=value>   Event metadata field filter, repeatable; string values, dot paths, * segment wildcard, ** recursive wildcard
  --data-json <path=json>   Event data field filter with typed JSON value
  --metadata-json <path=json> Event metadata field filter with typed JSON value
  --honor-filters           On webhooks test, skip delivery when the sample event does not match filters
  --transport <kind>        webhook or command
  --secret <secret>         Webhook signing secret
  --header <name=value>     Webhook header, repeatable
  --redact <path>           Redaction path, repeatable
  --no-deliver              Available on events emit`);
}

function printEventsHelp(options: RunEventsCliOptions = {}): void {
  const name = commandName(options);
  console.log(`${name} events

Usage:
  ${name} [--dir <path>] [--json] events emit <type>${options.source ? "" : " --source <source>"} [options]
  ${name} [--dir <path>] [--json] events list [--limit <n>]
  ${name} [--dir <path>] [--json] events replay [--id <event-id>] [--dry-run]

Options:
  --source <source>         Event source${options.source ? ` (default: ${options.source})` : ""}
  --subject <subject>       Event subject
  --severity <severity>     Event severity
  --message <message>       Human-readable event message
  --dedupe-key <key>        Deduplicate repeated events
  --data <json>             JSON object payload
  --metadata <json>         JSON object metadata
  --no-deliver              Record without delivering webhooks
  --dry-run                 Preview replay matches without delivery`);
}

export async function runEventsCli(argv = process.argv.slice(2), options: RunEventsCliOptions = {}): Promise<void> {
  const parsed = parseGlobalArgs(argv);
  const [group, command, ...tail] = parsed.rest;
  if (!group || group === "--help" || group === "-h") {
    printHelp(options);
    return;
  }
  if (group === "--version" || group === "-v") {
    console.log(version());
    return;
  }

  if (group === "status") {
    const status = await getEventsStatus(parsed.dir);
    output(parsed, status, () => {
      console.log(`events ${status.counts.events} event(s), ${status.counts.channels} channel(s), ${status.counts.deliveries} delivery record(s)`);
      console.log(`dataDir: ${status.dataDir}`);
    });
    return;
  }

  const store = new JsonEventsStore(parsed.dir);
  const client = new EventsClient({ store });

  if (group === "webhooks") {
    if (!command || command === "--help" || command === "-h") {
      printWebhooksHelp(options);
      return;
    }
    if (tail.includes("--help") || tail.includes("-h")) {
      printWebhooksHelp(options);
      return;
    }
    await handleWebhooks(client, command, tail, parsed, options);
    return;
  }
  if (group === "events") {
    if (!command || command === "--help" || command === "-h") {
      printEventsHelp(options);
      return;
    }
    if (tail.includes("--help") || tail.includes("-h")) {
      printEventsHelp(options);
      return;
    }
    await handleEvents(client, command, tail, parsed, options);
    return;
  }
  throw new Error(`Unknown command group: ${group}`);
}

async function handleWebhooks(client: EventsClient, command: string | undefined, tail: string[], parsed: ParsedArgs, options: RunEventsCliOptions): Promise<void> {
  if (command === "add") {
    const args = [...tail];
    const transport = (takeOption(args, "--transport") ?? "webhook") as TransportKind;
    const id = takeOption(args, "--id") ?? crypto.randomUUID();
    const name = takeOption(args, "--name");
    const secret = takeOption(args, "--secret");
    const timeoutMs = numberOption(takeOption(args, "--timeout-ms"));
    const retryAttempts = numberOption(takeOption(args, "--retry-attempts"));
    const retryBackoffMs = numberOption(takeOption(args, "--retry-backoff-ms"));
    const disabled = takeFlag(args, "--disabled");
    const headerValues = takeMany(args, "--header");
    const commandArgs = takeMany(args, "--arg");
    const redactions = takeMany(args, "--redact");
    const filters = parseFilter(args);
    const target = args[0];
    if (!target) throw new Error("webhooks add requires a URL or command target");
    const now = new Date().toISOString();
    const channel: ChannelConfig = {
      id,
      name,
      enabled: !disabled,
      transport,
      filters,
      retry: retryAttempts || retryBackoffMs ? { maxAttempts: retryAttempts, backoffMs: retryBackoffMs } : undefined,
      redact: redactions.length > 0 ? { paths: redactions } : undefined,
      createdAt: now,
      updatedAt: now,
    };
    if (transport === "webhook") {
      channel.webhook = { url: target, secret, headers: parseHeaders(headerValues), timeoutMs };
    } else if (transport === "command") {
      channel.command = { command: target, args: [...args.slice(1), ...commandArgs], timeoutMs };
    } else {
      throw new Error(`Transport ${transport} is reserved for future use and cannot be added yet`);
    }
    const saved = await client.addChannel(channel);
    output(parsed, sanitizeChannelForOutput(saved), () => console.log(`Added ${saved.transport} channel ${saved.id}`));
    return;
  }

  if (command === "list") {
    const channels = await client.listChannels();
    output(parsed, sanitizeChannelsForOutput(channels), () => {
      if (channels.length === 0) {
        console.log("No channels configured.");
        return;
      }
      for (const channel of channels) {
        const target = channel.webhook?.url ?? channel.command?.command ?? channel.transport;
        console.log(`${channel.id}\t${channel.enabled ? "enabled" : "disabled"}\t${channel.transport}\t${target}`);
      }
    });
    return;
  }

  if (command === "status") {
    const status = await getEventsStatus(parsed.dir);
    output(parsed, status, () => {
      console.log(`events dataDir: ${status.dataDir}`);
      console.log(`${status.counts.enabledChannels}/${status.counts.channels} channel(s) enabled`);
    });
    return;
  }

  if (command === "remove") {
    const id = tail[0];
    if (!id) throw new Error("webhooks remove requires a channel id");
    const removed = await client.removeChannel(id);
    output(parsed, { removed }, () => console.log(removed ? `Removed ${id}` : `Channel not found: ${id}`));
    return;
  }

  if (command === "test") {
    const args = [...tail];
    const id = args.shift();
    if (!id) throw new Error("webhooks test requires a channel id");
    const honorFilters = takeFlag(args, "--honor-filters");
    const result = await client.testChannel(id, {
      source: takeOption(args, "--source") ?? options.source ?? "hasna.events",
      type: takeOption(args, "--type") ?? "events.test",
      subject: takeOption(args, "--subject") ?? id,
      message: takeOption(args, "--message") ?? "Hasna events test delivery",
      data: parseJsonOption(takeOption(args, "--data"), { test: true }),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {}),
    }, { honorFilters });
    output(parsed, result, () => console.log(`${result.status}: ${result.channelId}`));
    return;
  }

  if (command === "match") {
    const args = [...tail];
    const id = args.shift();
    if (!id) throw new Error("webhooks match requires a channel id");
    const result = await client.matchChannel(id, {
      source: takeOption(args, "--source") ?? options.source ?? "hasna.events",
      type: takeOption(args, "--type") ?? "events.test",
      subject: takeOption(args, "--subject") ?? id,
      message: takeOption(args, "--message") ?? "Hasna events match preview",
      data: parseJsonOption(takeOption(args, "--data"), { test: true }),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {}),
    });
    output(parsed, result, () => console.log(`${result.matched ? "matched" : "skipped"}: ${result.channelId}`));
    return;
  }

  throw new Error(`Unknown webhooks command: ${command ?? ""}`);
}

async function handleEvents(client: EventsClient, command: string | undefined, tail: string[], parsed: ParsedArgs, options: RunEventsCliOptions): Promise<void> {
  if (command === "emit") {
    const args = [...tail];
    const type = args.shift();
    if (!type) throw new Error("events emit requires an event type");
    const source = takeOption(args, "--source") ?? options.source;
    if (!source) throw new Error("events emit requires --source");
    const noDeliver = takeFlag(args, "--no-deliver");
    const result = await client.emit({
      type,
      source,
      subject: takeOption(args, "--subject"),
      severity: severityOption(takeOption(args, "--severity")),
      message: takeOption(args, "--message"),
      dedupeKey: takeOption(args, "--dedupe-key"),
      data: parseJsonOption(takeOption(args, "--data"), {}),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {}),
    }, { deliver: !noDeliver });
    output(parsed, result, () => console.log(`${result.deduped ? "Deduped" : "Emitted"} ${result.event.id} to ${result.deliveries.length} channel(s)`));
    return;
  }

  if (command === "list") {
    const args = [...tail];
    const limit = numberOption(takeOption(args, "--limit"));
    const type = takeOption(args, "--type");
    const source = takeOption(args, "--source");
    let events = await client.listEvents();
    if (type) events = events.filter((event) => event.type === type);
    if (source) events = events.filter((event) => event.source === source);
    if (limit) events = events.slice(-limit);
    output(parsed, events, () => {
      if (events.length === 0) {
        console.log("No events recorded.");
        return;
      }
      for (const event of events) {
        console.log(`${event.time}\t${event.id}\t${event.source}\t${event.type}\t${event.severity}`);
      }
    });
    return;
  }

  if (command === "replay") {
    const args = [...tail];
    const result = await client.replay({
      eventId: takeOption(args, "--id"),
      source: takeOption(args, "--source"),
      type: takeOption(args, "--type"),
      dryRun: takeFlag(args, "--dry-run"),
    });
    output(parsed, result, () => console.log(`Replayed ${result.events.length} event(s), ${result.deliveries.length} delivery result(s)`));
    return;
  }

  throw new Error(`Unknown events command: ${command ?? ""}`);
}

function numberOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

function severityOption(value: string | undefined) {
  if (!value) return undefined;
  const allowed = new Set(["debug", "info", "notice", "warning", "error", "critical"]);
  if (!allowed.has(value)) throw new Error(`Invalid severity: ${value}`);
  return value as "debug" | "info" | "notice" | "warning" | "error" | "critical";
}

if (import.meta.main) {
  runEventsCli().catch((error) => {
    const parsed = parseGlobalArgs(process.argv.slice(2));
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(message);
    }
    process.exit(1);
  });
}
