import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelConfig, DeliveryResult, EventEnvelope, StoredEventsData } from "./types.js";

export const HASNA_EVENTS_DIR_ENV = "HASNA_EVENTS_DIR";
export const HASNA_EVENTS_HOME_ENV = "HASNA_EVENTS_HOME";

export function getEventsDataDir(override?: string): string {
  return override || process.env[HASNA_EVENTS_DIR_ENV] || process.env[HASNA_EVENTS_HOME_ENV] || join(homedir(), ".hasna", "events");
}

export interface EventsStore {
  dataDir: string;
  init(): Promise<void>;
  addChannel(channel: ChannelConfig): Promise<ChannelConfig>;
  listChannels(): Promise<ChannelConfig[]>;
  getChannel(id: string): Promise<ChannelConfig | undefined>;
  removeChannel(id: string): Promise<boolean>;
  appendEvent(event: EventEnvelope): Promise<EventEnvelope>;
  listEvents(): Promise<EventEnvelope[]>;
  findEventByIdentity(identity: { id?: string; dedupeKey?: string }): Promise<EventEnvelope | undefined>;
  appendDelivery(result: DeliveryResult): Promise<DeliveryResult>;
  listDeliveries(): Promise<DeliveryResult[]>;
}

export class JsonEventsStore implements EventsStore {
  dataDir: string;
  private channelsPath: string;
  private eventsPath: string;
  private deliveriesPath: string;

  constructor(dataDir = getEventsDataDir()) {
    this.dataDir = dataDir;
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

  async listEvents(): Promise<EventEnvelope[]> {
    await this.init();
    return this.readJson<EventEnvelope[]>(this.eventsPath, []);
  }

  async findEventByIdentity(identity: { id?: string; dedupeKey?: string }): Promise<EventEnvelope | undefined> {
    const events = await this.listEvents();
    return events.find((event) => (
      (identity.id !== undefined && event.id === identity.id) ||
      (identity.dedupeKey !== undefined && event.dedupeKey === identity.dedupeKey)
    ));
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
