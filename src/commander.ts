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
import {
  DEFAULT_LIST_LIMIT,
  formatChannelsTable,
  formatDeliveriesTable,
  formatEventsTable,
  formatListHint,
  formatSummaryHint,
  pageFromStart,
  parsePositiveInteger,
  recentPage,
  resolveHumanLimit,
} from "./cli/output.js";

type CommanderLike = any;
type CommanderCommandLike = any;
type OutputOptionLike = {
  json?: boolean;
  verbose?: boolean;
  opts?: () => { json?: boolean; verbose?: boolean };
  optsWithGlobals?: () => { json?: boolean; verbose?: boolean };
  parent?: {
    opts?: () => { json?: boolean; verbose?: boolean };
    optsWithGlobals?: () => { json?: boolean; verbose?: boolean };
  };
};

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

function hasJsonOption(options: OutputOptionLike | undefined): boolean {
  return Boolean(
    options?.json ||
    options?.opts?.().json ||
    options?.optsWithGlobals?.().json ||
    options?.parent?.opts?.().json ||
    options?.parent?.optsWithGlobals?.().json
  );
}

function wantsJson(actionOptions: OutputOptionLike, command?: OutputOptionLike): boolean {
  return hasJsonOption(actionOptions) || hasJsonOption(command);
}

function hasVerboseOption(options: OutputOptionLike | undefined): boolean {
  return Boolean(
    options?.verbose ||
    options?.opts?.().verbose ||
    options?.optsWithGlobals?.().verbose ||
    options?.parent?.opts?.().verbose ||
    options?.parent?.optsWithGlobals?.().verbose
  );
}

function wantsVerbose(actionOptions: OutputOptionLike, command?: OutputOptionLike): boolean {
  return hasVerboseOption(actionOptions) || hasVerboseOption(command);
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
    }, command?: CommanderCommandLike) => {
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
      print(sanitizeChannelForOutput(saved), wantsJson(actionOptions, command), `Added ${saved.transport} channel ${saved.id}`);
    });

  webhooks
    .command("list")
    .description("List configured subscriptions")
    .option("--limit <n>", `Limit list rows (human default: ${DEFAULT_LIST_LIMIT})`, parseLimit)
    .option("--verbose", "Show extra compact columns", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (actionOptions: { limit?: number; verbose?: boolean; json?: boolean }, command?: CommanderCommandLike) => {
      const sanitizedChannels = sanitizeChannelsForOutput(await createClient(options).listChannels());
      if (wantsJson(actionOptions, command)) {
        console.log(JSON.stringify(actionOptions.limit ? sanitizedChannels.slice(0, actionOptions.limit) : sanitizedChannels, null, 2));
        return;
      }
      if (!sanitizedChannels.length) {
        console.log("No channels configured.");
        return;
      }
      const page = pageFromStart(sanitizedChannels, resolveHumanLimit(actionOptions.limit));
      console.log(formatChannelsTable(page.rows, wantsVerbose(actionOptions, command)));
      console.log(formatListHint(`${options.webhooksCommandName ?? "webhooks"} list`, page, `${options.webhooksCommandName ?? "webhooks"} show <id>`));
    });

  webhooks
    .command("show")
    .alias("inspect")
    .description("Show one sanitized subscription")
    .argument("<id>", "Subscription/channel identifier")
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, actionOptions: { json?: boolean }, command?: CommanderCommandLike) => {
      const channel = (await createClient(options).listChannels()).find((item) => item.id === id);
      if (!channel) throw new Error(`Channel not found: ${id}`);
      const sanitized = sanitizeChannelForOutput(channel);
      print(sanitized, wantsJson(actionOptions, command), JSON.stringify(sanitized, null, 2));
    });

  webhooks.command("remove").description("Remove a subscription").argument("<id>", "Subscription/channel identifier").option("-j, --json", "Print JSON output", false).action(async (id: string, actionOptions: { json?: boolean }, command?: CommanderCommandLike) => {
    const removed = await createClient(options).removeChannel(id);
    print({ removed }, wantsJson(actionOptions, command), removed ? `Removed ${id}` : `Channel not found: ${id}`);
  });

  webhooks
    .command("test")
    .description("Send a test event to one subscription")
    .argument("<id>", "Subscription/channel identifier")
    .option("--type <type>", "Event type", "events.test")
    .option("--subject <subject>", "Event subject")
    .option("--message <message>", "Event message", "Hasna events test delivery")
    .option("--data <json>", "Event data JSON object")
    .option("--verbose", "Show compact delivery attempt columns", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, actionOptions: { type: string; subject?: string; message: string; data?: string; verbose?: boolean; json?: boolean }, command?: CommanderCommandLike) => {
      const result = await createClient(options).testChannel(id, {
        source: options.source,
        type: actionOptions.type,
        subject: actionOptions.subject ?? id,
        message: actionOptions.message,
        data: parseJsonObject(actionOptions.data, { test: true }),
      });
      if (wantsJson(actionOptions, command)) {
        console.log(JSON.stringify(result, null, 2));
      } else if (wantsVerbose(actionOptions, command)) {
        console.log(`${result.status}: ${result.channelId}`);
        console.log(formatDeliveriesTable([result]));
      } else {
        console.log(`${result.status}: ${result.channelId}`);
        console.log(formatSummaryHint(`${options.webhooksCommandName ?? "webhooks"} test ${id}`, `${options.webhooksCommandName ?? "webhooks"} show ${id}`));
      }
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
    }, command?: CommanderCommandLike) => {
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
      print(result, wantsJson(actionOptions, command), `${result.deduped ? "Deduped" : "Emitted"} ${result.event.id} to ${result.deliveries.length} channel(s)`);
    });

  events
    .command("list")
    .description("List recorded events")
    .option("--source <source>", "Filter by source")
    .option("--type <type>", "Filter by type")
    .option("--limit <n>", `Limit list rows (human default: ${DEFAULT_LIST_LIMIT})`, parseLimit)
    .option("--cursor <event-id>", "Show older events before this event id")
    .option("--verbose", "Show extra compact columns", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (actionOptions: { source?: string; type?: string; limit?: number; cursor?: string; verbose?: boolean; json?: boolean }, command?: CommanderCommandLike) => {
      let rows = await createClient(options).listEvents();
      if (actionOptions.source) rows = rows.filter((event) => event.source === actionOptions.source);
      if (actionOptions.type) rows = rows.filter((event) => event.type === actionOptions.type);
      if (wantsJson(actionOptions, command)) {
        const jsonRows = actionOptions.cursor
          ? recentPage(rows, resolveHumanLimit(actionOptions.limit), actionOptions.cursor).rows
          : actionOptions.limit
            ? rows.slice(-actionOptions.limit)
            : rows;
        console.log(JSON.stringify(jsonRows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log("No events recorded.");
        return;
      }
      const page = recentPage(rows, resolveHumanLimit(actionOptions.limit), actionOptions.cursor);
      if (!page.rows.length) {
        console.log("No events on this page.");
        console.log(formatListHint(`${options.eventsCommandName ?? "events"} list`, page, `${options.eventsCommandName ?? "events"} show <id>`, {
          afterLabel: "newer",
          cursorLabel: "for older rows",
        }));
        return;
      }
      console.log(formatEventsTable(page.rows, wantsVerbose(actionOptions, command)));
      console.log(formatListHint(`${options.eventsCommandName ?? "events"} list`, page, `${options.eventsCommandName ?? "events"} show <id>`, {
        afterLabel: "newer",
        cursorLabel: "for older rows",
      }));
    });

  events
    .command("show")
    .alias("inspect")
    .description("Show one recorded event")
    .argument("<id>", "Event id")
    .option("-j, --json", "Print JSON output", false)
    .action(async (id: string, actionOptions: { json?: boolean }, command?: CommanderCommandLike) => {
      const event = (await createClient(options).listEvents()).find((item) => item.id === id);
      if (!event) throw new Error(`Event not found: ${id}`);
      print(event, wantsJson(actionOptions, command), JSON.stringify(event, null, 2));
    });

  events
    .command("replay")
    .description("Replay recorded events")
    .option("--id <id>", "Replay one event id")
    .option("--source <source>", "Filter by source")
    .option("--type <type>", "Filter by type")
    .option("--dry-run", "Preview without delivery", false)
    .option("--limit <n>", `Limit verbose preview rows (default: ${DEFAULT_LIST_LIMIT})`, parseLimit)
    .option("--verbose", "Show compact replay preview rows", false)
    .option("-j, --json", "Print JSON output", false)
    .action(async (actionOptions: { id?: string; source?: string; type?: string; dryRun?: boolean; limit?: number; verbose?: boolean; json?: boolean }, command?: CommanderCommandLike) => {
      const result = await createClient(options).replay({
        eventId: actionOptions.id,
        source: actionOptions.source,
        type: actionOptions.type,
        dryRun: actionOptions.dryRun,
      });
      if (wantsJson(actionOptions, command)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Replayed ${result.events.length} event(s), ${result.deliveries.length} delivery result(s)`);
      if (wantsVerbose(actionOptions, command)) {
        const eventPage = { ...recentPage(result.events, resolveHumanLimit(actionOptions.limit)), nextCursor: undefined };
        if (eventPage.rows.length > 0) {
          console.log(formatEventsTable(eventPage.rows, true));
          console.log(formatListHint(`${options.eventsCommandName ?? "events"} replay`, eventPage, `${options.eventsCommandName ?? "events"} show <id>`));
        }
        const deliveryPage = { ...recentPage(result.deliveries, resolveHumanLimit(actionOptions.limit)), nextCursor: undefined };
        if (deliveryPage.rows.length > 0) console.log(formatDeliveriesTable(deliveryPage.rows));
      } else {
        console.log(formatSummaryHint(`${options.eventsCommandName ?? "events"} replay`, `${options.eventsCommandName ?? "events"} show <id>`));
      }
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

function parseLimit(value: string): number {
  return parsePositiveInteger(value, "--limit") ?? DEFAULT_LIST_LIMIT;
}

function collectValues(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
