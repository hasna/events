import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChannelConfig,
  DeliveryResult,
  EventAppendOptions,
  EventAppendResult,
  EventEnvelope,
  EventPage,
  EventPageOptions,
  EventsStatus,
  EventsStoreRuntime,
  StoredEventsData,
} from "./types.js";

export const HASNA_EVENTS_DIR_ENV = "HASNA_EVENTS_DIR";
export const HASNA_EVENTS_HOME_ENV = "HASNA_EVENTS_HOME";
export const LOCAL_JSON_EVENT_CURSOR_PREFIX = "local-json-v1:";
export const DEFAULT_EVENT_PAGE_LIMIT = 100;
export const MAX_EVENT_PAGE_LIMIT = 1000;

export function getEventsDataDir(override?: string): string {
  return override || process.env[HASNA_EVENTS_DIR_ENV] || process.env[HASNA_EVENTS_HOME_ENV] || join(homedir(), ".hasna", "events");
}

export function getActiveEventsDirEnv(): EventsStatus["env"]["active"] {
  if (process.env[HASNA_EVENTS_DIR_ENV]) return HASNA_EVENTS_DIR_ENV;
  if (process.env[HASNA_EVENTS_HOME_ENV]) return HASNA_EVENTS_HOME_ENV;
  return null;
}

export interface EventsStore {
  dataDir: string;
  runtime?: EventsStoreRuntime;
  init(): Promise<void>;
  addChannel(channel: ChannelConfig): Promise<ChannelConfig>;
  listChannels(): Promise<ChannelConfig[]>;
  getChannel(id: string): Promise<ChannelConfig | undefined>;
  removeChannel(id: string): Promise<boolean>;
  appendEvent(event: EventEnvelope): Promise<EventEnvelope>;
  appendEventOnce?(event: EventEnvelope, options?: EventAppendOptions): Promise<EventAppendResult>;
  listEvents(options?: EventPageOptions): Promise<EventEnvelope[]>;
  listEventsPage?(options?: EventPageOptions): Promise<EventPage>;
  findEventByIdentity(identity: { id?: string; dedupeKey?: string }): Promise<EventEnvelope | undefined>;
  appendDelivery(result: DeliveryResult): Promise<DeliveryResult>;
  listDeliveries(): Promise<DeliveryResult[]>;
}

export class JsonEventsStore implements EventsStore {
  dataDir: string;
  runtime: EventsStoreRuntime;
  private channelsPath: string;
  private eventsPath: string;
  private deliveriesPath: string;

  constructor(dataDir = getEventsDataDir()) {
    this.dataDir = dataDir;
    this.runtime = localJsonRuntime(dataDir);
    this.channelsPath = join(dataDir, "channels.json");
    this.eventsPath = join(dataDir, "events.json");
    this.deliveriesPath = join(dataDir, "deliveries.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700).catch(() => undefined);
    await this.ensureArrayFile(this.channelsPath);
    await this.ensureArrayFile(this.eventsPath);
    await this.ensureArrayFile(this.deliveriesPath);
  }

  async addChannel(channel: ChannelConfig): Promise<ChannelConfig> {
    await this.init();
    const channels = await this.readJson<ChannelConfig[]>(this.channelsPath, []);
    const index = channels.findIndex((item) => item.id === channel.id);
    if (index >= 0) {
      channels[index] = { ...channel, createdAt: channels[index].createdAt, updatedAt: new Date().toISOString() };
    } else {
      channels.push(channel);
    }
    await this.writeJson(this.channelsPath, channels);
    return index >= 0 ? channels[index] : channel;
  }

  async listChannels(): Promise<ChannelConfig[]> {
    await this.init();
    return this.readJson<ChannelConfig[]>(this.channelsPath, []);
  }

  async getChannel(id: string): Promise<ChannelConfig | undefined> {
    const channels = await this.listChannels();
    return channels.find((channel) => channel.id === id);
  }

  async removeChannel(id: string): Promise<boolean> {
    await this.init();
    const channels = await this.readJson<ChannelConfig[]>(this.channelsPath, []);
    const next = channels.filter((channel) => channel.id !== id);
    await this.writeJson(this.channelsPath, next);
    return next.length !== channels.length;
  }

  async appendEvent(event: EventEnvelope): Promise<EventEnvelope> {
    await this.init();
    const events = await this.readJson<EventEnvelope[]>(this.eventsPath, []);
    events.push(event);
    await this.writeJson(this.eventsPath, events);
    return event;
  }

  async appendEventOnce(event: EventEnvelope, options: EventAppendOptions = {}): Promise<EventAppendResult> {
    await this.init();
    const events = await this.readJson<EventEnvelope[]>(this.eventsPath, []);
    const dedupe = options.dedupe !== false;
    if (dedupe) {
      const existing = findEventByIdentity(events, { id: event.id, dedupeKey: event.dedupeKey });
      if (existing) {
        return {
          event: existing,
          stored: false,
          deduped: true,
          identity: { id: existing.id, dedupeKey: existing.dedupeKey },
        };
      }
    }
    events.push(event);
    await this.writeJson(this.eventsPath, events);
    return {
      event,
      stored: true,
      deduped: false,
      identity: { id: event.id, dedupeKey: event.dedupeKey },
    };
  }

  async listEvents(options: EventPageOptions = {}): Promise<EventEnvelope[]> {
    await this.init();
    const events = await this.readJson<EventEnvelope[]>(this.eventsPath, []);
    return queryEvents(events, options);
  }

  async listEventsPage(options: EventPageOptions = {}): Promise<EventPage> {
    await this.init();
    const events = await this.readJson<EventEnvelope[]>(this.eventsPath, []);
    const queried = queryEvents(events, {
      eventId: options.eventId,
      source: options.source,
      type: options.type,
    });
    const offset = decodeLocalJsonEventCursor(options.cursor, options);
    const limit = normalizeEventPageLimit(options.limit);
    const pageEvents = queried.slice(offset, offset + limit);
    const nextOffset = offset + pageEvents.length;
    const hasMore = nextOffset < queried.length;
    return {
      events: pageEvents,
      cursor: options.cursor,
      nextCursor: hasMore ? encodeLocalJsonEventCursor(nextOffset, options) : undefined,
      hasMore,
    };
  }

  async findEventByIdentity(identity: { id?: string; dedupeKey?: string }): Promise<EventEnvelope | undefined> {
    const events = await this.listEvents();
    return findEventByIdentity(events, identity);
  }

  async appendDelivery(result: DeliveryResult): Promise<DeliveryResult> {
    await this.init();
    const deliveries = await this.readJson<DeliveryResult[]>(this.deliveriesPath, []);
    deliveries.push(result);
    await this.writeJson(this.deliveriesPath, deliveries);
    return result;
  }

  async listDeliveries(): Promise<DeliveryResult[]> {
    await this.init();
    return this.readJson<DeliveryResult[]>(this.deliveriesPath, []);
  }

  async exportData(): Promise<StoredEventsData> {
    return {
      channels: await this.listChannels(),
      events: await this.listEvents(),
      deliveries: await this.listDeliveries(),
    };
  }

  private async ensureArrayFile(path: string): Promise<void> {
    if (!existsSync(path)) {
      await writeFile(path, "[]\n", { encoding: "utf-8", mode: 0o600 });
    }
    await chmod(path, 0o600).catch(() => undefined);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(path, "utf-8");
      if (!raw.trim()) return fallback;
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    await rename(tempPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  }
}

export function localJsonRuntime(dataDir = getEventsDataDir()): EventsStoreRuntime {
  return {
    mode: "local-files",
    name: "json-events-store",
    remote: false,
    localFiles: true,
    localSqlite: false,
    postgres: false,
    s3: false,
    aws: false,
    durable: true,
    idempotency: "best-effort-local",
    replayCursors: true,
    description: `Local JSON files in ${dataDir}; no SQLite, Postgres, S3, or AWS runtime is configured by this store.`,
  };
}

export function encodeLocalJsonEventCursor(offset: number, options: EventPageOptions = {}): string {
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`Invalid event cursor offset: ${offset}`);
  const payload: LocalJsonEventCursor = {
    offset,
    eventId: options.eventId,
    source: options.source,
    type: options.type,
  };
  return `${LOCAL_JSON_EVENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")}`;
}

export function decodeLocalJsonEventCursor(cursor: string | undefined, options: EventPageOptions = {}): number {
  if (!cursor) return 0;
  if (!cursor.startsWith(LOCAL_JSON_EVENT_CURSOR_PREFIX)) throw new Error(`Invalid local JSON event cursor: ${cursor}`);
  const rawPayload = cursor.slice(LOCAL_JSON_EVENT_CURSOR_PREFIX.length);
  let payload: LocalJsonEventCursor;
  try {
    payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf-8")) as LocalJsonEventCursor;
  } catch {
    throw new Error(`Invalid local JSON event cursor: ${cursor}`);
  }
  const offset = payload.offset;
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`Invalid local JSON event cursor: ${cursor}`);
  assertCursorFilter("eventId", payload.eventId, options.eventId);
  assertCursorFilter("source", payload.source, options.source);
  assertCursorFilter("type", payload.type, options.type);
  return offset;
}

export function normalizeEventPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EVENT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Event page limit must be a positive integer, got ${limit}`);
  return Math.min(limit, MAX_EVENT_PAGE_LIMIT);
}

function queryEvents(events: EventEnvelope[], options: EventPageOptions): EventEnvelope[] {
  let rows = events;
  if (options.eventId) rows = rows.filter((event) => event.id === options.eventId);
  if (options.source) rows = rows.filter((event) => event.source === options.source);
  if (options.type) rows = rows.filter((event) => event.type === options.type);
  if (options.cursor) {
    const offset = decodeLocalJsonEventCursor(options.cursor, options);
    rows = rows.slice(offset);
  }
  if (options.limit !== undefined) rows = rows.slice(0, normalizeEventPageLimit(options.limit));
  return rows;
}

interface LocalJsonEventCursor {
  offset: number;
  eventId?: string;
  source?: string;
  type?: string;
}

function assertCursorFilter(name: keyof Omit<LocalJsonEventCursor, "offset">, cursorValue: string | undefined, optionValue: string | undefined): void {
  if (cursorValue !== optionValue) throw new Error(`Local JSON event cursor ${name} filter mismatch`);
}

function findEventByIdentity(events: EventEnvelope[], identity: { id?: string; dedupeKey?: string }): EventEnvelope | undefined {
  return events.find((event) => (
    (identity.id !== undefined && event.id === identity.id) ||
    (identity.dedupeKey !== undefined && event.dedupeKey === identity.dedupeKey)
  ));
}

export async function getEventsStatus(dataDir?: string): Promise<EventsStatus> {
  const store = new JsonEventsStore(dataDir);
  await store.init();
  const [channels, events, deliveries] = await Promise.all([
    store.listChannels(),
    store.listEvents(),
    store.listDeliveries(),
  ]);
  const transports = channels.reduce<Record<string, number>>((counts, channel) => {
    counts[channel.transport] = (counts[channel.transport] ?? 0) + 1;
    return counts;
  }, {});

  return {
    service: "events",
    schemaVersion: "1.0",
    dataDir: store.dataDir,
    storage: store.runtime,
    env: {
      primary: HASNA_EVENTS_DIR_ENV,
      fallback: HASNA_EVENTS_HOME_ENV,
      active: getActiveEventsDirEnv(),
    },
    files: {
      channels: statusFile(store.dataDir, "channels.json", channels.length),
      events: statusFile(store.dataDir, "events.json", events.length),
      deliveries: statusFile(store.dataDir, "deliveries.json", deliveries.length),
    },
    counts: {
      channels: channels.length,
      enabledChannels: channels.filter((channel) => channel.enabled).length,
      disabledChannels: channels.filter((channel) => !channel.enabled).length,
      events: events.length,
      deliveries: deliveries.length,
    },
    transports,
    safety: {
      includesEventPayloads: false,
      includesWebhookSecrets: false,
      listOutputsRedactSecrets: true,
      statusOutputIsMetadataOnly: true,
    },
  };
}

function statusFile(dataDir: string, fileName: string, records: number): EventsStatus["files"][keyof EventsStatus["files"]] {
  const path = join(dataDir, fileName);
  return { path, exists: existsSync(path), records };
}
