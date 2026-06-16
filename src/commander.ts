import {
  EventsClient,
  JsonEventsStore,
  sanitizeChannelForOutput,
  sanitizeChannelsForOutput,
  type ChannelConfig,
  type EventFilter,
  type EventInput,
  type TransportKind,
} from "./index.js";

type CommanderLike = any;
type CommanderCommandLike = any;

export interface RegisterEventsCommandsOptions {
  source: string;
  dataDir?: string;
  createClient?: () => EventsClient;
  webhooksCommandName?: string;
  eventsCommandName?: string;
}

function parseJsonObject(value: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!value) return fallback;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseHeaders(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) throw new Error(`Invalid header, expected name=value: ${value}`);
    headers[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return headers;
}

function parseFilter(options: { source?: string; type?: string; subject?: string; severity?: string }): EventFilter[] | undefined {
  const filter: EventFilter = {};
  if (options.source) filter.source = options.source;
  if (options.type) filter.type = options.type;
  if (options.subject) filter.subject = options.subject;
  if (options.severity) filter.severity = options.severity;
  return Object.keys(filter).length > 0 ? [filter] : undefined;
}

function createClient(options: RegisterEventsCommandsOptions): EventsClient {
  if (options.createClient) return options.createClient();
  return new EventsClient({ store: new JsonEventsStore(options.dataDir) });
}

function print(value: unknown, json: boolean, text: string): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(text);
}

export function registerWebhookCommands(program: CommanderLike, options: RegisterEventsCommandsOptions): CommanderCommandLike {
  const webhooks = program.command(options.webhooksCommandName ?? "webhooks").description("Manage Hasna event webhook subscriptions");

  webhooks
    .command("add")
    .description("Add or replace a webhook or command subscription")
    .argument("<target>", "Webhook URL or command binary")
    .requiredOption("--id <id>", "Subscription/channel identifier")
    .option("--transport <kind>", "Transport kind: webhook or command", "webhook")
    .option("--name <name>", "Display name")
    .option("--type <pattern>", "Event type filter, e.g. todos.task.*")
    .option("--source <pattern>", "Event source filter")
    .option("--subject <pattern>", "Event subject filter")
    .option("--severity <pattern>", "Event severity filter")
    .option("--secret <secret>", "Webhook HMAC secret")
    .option("--header <name=value...>", "Webhook header", collectValues, [] as string[])
    .option("--arg <arg...>", "Command argument", collectValues, [] as string[])
    .option("--timeout-ms <ms>", "Transport timeout in milliseconds", parseNumber)
    .option("--retry-attempts <n>", "Maximum delivery attempts", parseNumber)
    .option("--retry-backoff-ms <ms>", "Initial retry backoff in milliseconds", parseNumber)
    .option("--redact <path...>", "Event field path to redact before delivery", collectValues, [] as string[])
    .option("--disabled", "Create channel disabled", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (target: string, actionOptions: {
      id: string;
      transport: TransportKind;
      name?: string;
      type?: string;
      source?: string;
      subject?: string;
      severity?: string;
      secret?: string;
      header?: string[];
      arg?: string[];
      timeoutMs?: number;
      retryAttempts?: number;
      retryBackoffMs?: number;
      redact?: string[];
      disabled?: boolean;
      json?: boolean;
    }) => {
      const timestamp = new Date().toISOString();
      const channel: ChannelConfig = {
        id: actionOptions.id,
        name: actionOptions.name,
        enabled: !actionOptions.disabled,
        transport: actionOptions.transport,
        filters: parseFilter(actionOptions),
        retry: actionOptions.retryAttempts || actionOptions.retryBackoffMs
          ? { maxAttempts: actionOptions.retryAttempts, backoffMs: actionOptions.retryBackoffMs }
          : undefined,
        redact: actionOptions.redact?.length ? { paths: actionOptions.redact } : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (actionOptions.transport === "webhook") {
        channel.webhook = { url: target, secret: actionOptions.secret, headers: parseHeaders(actionOptions.header), timeoutMs: actionOptions.timeoutMs };
      } else if (actionOptions.transport === "command") {
        channel.command = { command: target, args: actionOptions.arg ?? [], timeoutMs: actionOptions.timeoutMs };
      } else {
        throw new Error(`Transport ${actionOptions.transport} is reserved for future use and cannot be added yet`);
      }
      const saved = await createClient(options).addChannel(channel);
      print(sanitizeChannelForOutput(saved), Boolean(actionOptions.json), `Added ${saved.transport} channel ${saved.id}`);
    });

  webhooks.command("list").description("List configured subscriptions").option("-j, --json", "Print JSON output", false).action(async (actionOptions: { json?: boolean }) => {
    const channels = await createClient(options).listChannels();
    if (actionOptions.json) {
      console.log(JSON.stringify(sanitizeChannelsForOutput(channels), null, 2));
      return;
    }
    if (!channels.length) {
      console.log("No channels configured.");
      return;
    }
    for (const channel of channels) {
      console.log(`${channel.id}\t${channel.enabled ? "enabled" : "disabled"}\t${channel.transport}\t${channel.webhook?.url ?? channel.command?.command ?? channel.transport}`);
    }
  });

  webhooks.command("remove").description("Remove a subscription").argument("<id>", "Subscription/channel identifier").option("-j, --json", "Print JSON output", false).action(async (id: string, actionOptions: { json?: boolean }) => {
    const removed = await createClient(options).removeChannel(id);
    print({ removed }, Boolean(actionOptions.json), removed ? `Removed ${id}` : `Channel not found: ${id}`);
  });

  webhooks
    .command("test")
    .description("Send a test event to one subscription")
    .argument("<id>", "Subscription/channel identifier")
    .option("--type <type>", "Event type", "events.test")
    .option("--subject <subject>", "Event subject")
    .option("--message <message>", "Event message", "Hasna events test delivery")
    .option("--data <json>", "Event data JSON object")
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, actionOptions: { type: string; subject?: string; message: string; data?: string; json?: boolean }) => {
      const result = await createClient(options).testChannel(id, {
        source: options.source,
        type: actionOptions.type,
        subject: actionOptions.subject ?? id,
        message: actionOptions.message,
        data: parseJsonObject(actionOptions.data, { test: true }),
      });
      print(result, Boolean(actionOptions.json), `${result.status}: ${result.channelId}`);
    });

  return webhooks;
}

export function registerEventCommands(program: CommanderLike, options: RegisterEventsCommandsOptions): CommanderCommandLike {
  const events = program.command(options.eventsCommandName ?? "events").description("Emit, list, and replay Hasna events");

  events
    .command("emit")
    .description("Emit an event from this app")
    .argument("<type>", "Event type")
    .option("--source <source>", "Event source override")
    .option("--subject <subject>", "Event subject")
    .option("--severity <severity>", "Event severity", "info")
    .option("--message <message>", "Event message")
    .option("--dedupe-key <key>", "Dedupe key")
    .option("--data <json>", "Event data JSON object")
    .option("--metadata <json>", "Event metadata JSON object")
    .option("--no-deliver", "Record without delivering")
    .option("--no-dedupe", "Allow duplicate id/dedupeKey events")
    .option("-j, --json", "Print JSON output", false)
    .action(async (type: string, actionOptions: {
      source?: string;
      subject?: string;
      severity?: EventInput["severity"];
      message?: string;
      dedupeKey?: string;
      data?: string;
      metadata?: string;
      deliver?: boolean;
      dedupe?: boolean;
      json?: boolean;
    }) => {
      const result = await createClient(options).emit({
        source: actionOptions.source ?? options.source,
        type,
        subject: actionOptions.subject,
        severity: actionOptions.severity,
        message: actionOptions.message,
        dedupeKey: actionOptions.dedupeKey,
        data: parseJsonObject(actionOptions.data, {}),
        metadata: parseJsonObject(actionOptions.metadata, {}),
      }, { deliver: actionOptions.deliver, dedupe: actionOptions.dedupe });
      print(result, Boolean(actionOptions.json), `${result.deduped ? "Deduped" : "Emitted"} ${result.event.id} to ${result.deliveries.length} channel(s)`);
    });

  events.command("list").description("List recorded events").option("--source <source>", "Filter by source").option("--type <type>", "Filter by type").option("--limit <n>", "Limit results", parseNumber).option("-j, --json", "Print JSON output", false).action(async (actionOptions: { source?: string; type?: string; limit?: number; json?: boolean }) => {
    let rows = await createClient(options).listEvents();
    if (actionOptions.source) rows = rows.filter((event) => event.source === actionOptions.source);
    if (actionOptions.type) rows = rows.filter((event) => event.type === actionOptions.type);
    if (actionOptions.limit) rows = rows.slice(-actionOptions.limit);
    if (actionOptions.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (!rows.length) {
      console.log("No events recorded.");
      return;
    }
    for (const event of rows) console.log(`${event.time}\t${event.id}\t${event.source}\t${event.type}\t${event.severity}`);
  });

  events.command("replay").description("Replay recorded events").option("--id <id>", "Replay one event id").option("--source <source>", "Filter by source").option("--type <type>", "Filter by type").option("--dry-run", "Preview without delivery", false).option("-j, --json", "Print JSON output", false).action(async (actionOptions: { id?: string; source?: string; type?: string; dryRun?: boolean; json?: boolean }) => {
    const result = await createClient(options).replay({
      eventId: actionOptions.id,
      source: actionOptions.source,
      type: actionOptions.type,
      dryRun: actionOptions.dryRun,
    });
    print(result, Boolean(actionOptions.json), `Replayed ${result.events.length} event(s), ${result.deliveries.length} delivery result(s)`);
  });

  return events;
}

export function registerEventsCommands(program: CommanderLike, options: RegisterEventsCommandsOptions): void {
  registerWebhookCommands(program, options);
  registerEventCommands(program, options);
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, got ${value}`);
  return parsed;
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
