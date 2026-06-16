import { randomUUID } from "node:crypto";
import type {
  ChannelConfig,
  DeliveryAttempt,
  DeliveryResult,
  EmitOptions,
  EmitResult,
  EventEnvelope,
  EventInput,
  EventRedactor,
  ReplayOptions,
  RetryPolicy,
} from "./types.js";
import { channelMatchesEvent } from "./filter.js";
import { JsonEventsStore, type EventsStore } from "./storage.js";
import { createDeliveryResult, dispatchChannel, type TransportDispatchOptions } from "./transports.js";

export * from "./types.js";
export * from "./storage.js";
export * from "./filter.js";
export * from "./signing.js";
export * from "./transports.js";

export interface EventsClientOptions extends TransportDispatchOptions {
  store?: EventsStore;
  dataDir?: string;
  redactors?: EventRedactor[];
}

export function createEvent<TData extends Record<string, unknown>>(input: EventInput<TData>): EventEnvelope<TData> {
  return {
    id: input.id ?? randomUUID(),
    source: input.source,
    type: input.type,
    time: normalizeTime(input.time),
    subject: input.subject,
    severity: input.severity ?? "info",
    data: input.data ?? ({} as TData),
    message: input.message,
    dedupeKey: input.dedupeKey,
    schemaVersion: input.schemaVersion ?? "1.0",
    metadata: input.metadata ?? {},
  };
}

export class EventsClient {
  private store: EventsStore;
  private redactors: EventRedactor[];
  private transportOptions: TransportDispatchOptions;

  constructor(options: EventsClientOptions = {}) {
    this.store = options.store ?? new JsonEventsStore(options.dataDir);
    this.redactors = options.redactors ?? [];
    this.transportOptions = { fetchImpl: options.fetchImpl };
  }

  async addChannel(input: Omit<ChannelConfig, "createdAt" | "updatedAt"> & Partial<Pick<ChannelConfig, "createdAt" | "updatedAt">>): Promise<ChannelConfig> {
    const timestamp = new Date().toISOString();
    return this.store.addChannel({
      ...input,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
    });
  }

  async listChannels(): Promise<ChannelConfig[]> {
    return this.store.listChannels();
  }

  async removeChannel(id: string): Promise<boolean> {
    return this.store.removeChannel(id);
  }

  async emit<TData extends Record<string, unknown>>(input: EventInput<TData>, options: EmitOptions = {}): Promise<EmitResult<TData>> {
    const event = options.redactSensitiveData === false
      ? createEvent(input)
      : redactSensitiveKeys(createEvent(input));
    if (options.dedupe !== false) {
      const existing = await this.store.findEventByIdentity({ id: input.id, dedupeKey: event.dedupeKey });
      if (existing) {
        return { event: existing as EventEnvelope<TData>, deliveries: [], deduped: true };
      }
    }
    await this.store.appendEvent(event);
    const deliveries = options.deliver === false ? [] : await this.deliver(event);
    return { event, deliveries, deduped: false };
  }

  async listEvents(): Promise<EventEnvelope[]> {
    return this.store.listEvents();
  }

  async listDeliveries(): Promise<DeliveryResult[]> {
    return this.store.listDeliveries();
  }

  async deliver(event: EventEnvelope): Promise<DeliveryResult[]> {
    const channels = await this.store.listChannels();
    const selected = channels.filter((channel) => channelMatchesEvent(channel, event));
    const deliveries: DeliveryResult[] = [];
    for (const channel of selected) {
      const eventForChannel = await this.applyRedaction(event, channel);
      const result = await this.deliverWithRetry(eventForChannel, channel);
      await this.store.appendDelivery(result);
      deliveries.push(result);
    }
    return deliveries;
  }

  async testChannel(id: string, input: Partial<EventInput> = {}): Promise<DeliveryResult> {
    const channel = await this.store.getChannel(id);
    if (!channel) throw new Error(`Channel not found: ${id}`);
    const event = createEvent({
      source: input.source ?? "hasna.events",
      type: input.type ?? "events.test",
      subject: input.subject ?? id,
      severity: input.severity ?? "info",
      data: input.data ?? { test: true },
      message: input.message ?? "Hasna events test delivery",
      dedupeKey: input.dedupeKey,
      schemaVersion: input.schemaVersion,
      metadata: input.metadata,
      time: input.time,
      id: input.id,
    });
    const eventForChannel = await this.applyRedaction(event, channel);
    const result = await this.deliverWithRetry(eventForChannel, channel);
    await this.store.appendDelivery(result);
    return result;
  }

  async replay(options: ReplayOptions = {}): Promise<{ events: EventEnvelope[]; deliveries: DeliveryResult[] }> {
    const events = (await this.store.listEvents()).filter((event) => {
      if (options.eventId && event.id !== options.eventId) return false;
      if (options.source && event.source !== options.source) return false;
      if (options.type && event.type !== options.type) return false;
      return true;
    });
    if (options.dryRun) return { events, deliveries: [] };
    const deliveries: DeliveryResult[] = [];
    for (const event of events) {
      deliveries.push(...await this.deliver(event));
    }
    return { events, deliveries };
  }

  private async applyRedaction(event: EventEnvelope, channel: ChannelConfig): Promise<EventEnvelope> {
    let next = redactPaths(event, channel.redact?.paths ?? [], channel.redact?.replacement ?? "[REDACTED]");
    for (const redactor of this.redactors) {
      next = await redactor(next, channel);
    }
    return next;
  }

  private async deliverWithRetry(event: EventEnvelope, channel: ChannelConfig): Promise<DeliveryResult> {
    const policy = normalizeRetryPolicy(channel.retry);
    const attempts: DeliveryAttempt[] = [];
    for (let index = 0; index < policy.maxAttempts; index += 1) {
      const attempt = await dispatchChannel(event, channel, this.transportOptions);
      attempt.attempt = index + 1;
      if (attempt.status === "failed" && index + 1 < policy.maxAttempts) {
        attempt.nextBackoffMs = Math.round(policy.backoffMs * policy.multiplier ** index);
      }
      attempts.push(attempt);
      if (attempt.status !== "failed") break;
      if (attempt.nextBackoffMs) await Bun.sleep(attempt.nextBackoffMs);
    }
    return createDeliveryResult(event, channel, attempts);
  }
}

export function redactPaths<T extends EventEnvelope>(event: T, paths: string[], replacement = "[REDACTED]"): T {
  if (paths.length === 0) return event;
  const copy = structuredClone(event);
  for (const path of paths) {
    setPath(copy as unknown as Record<string, unknown>, path, replacement);
  }
  return copy;
}

export function sanitizeChannelForOutput(channel: ChannelConfig): ChannelConfig {
  const copy = structuredClone(channel);
  if (copy.webhook?.secret) copy.webhook.secret = "[REDACTED]";
  if (copy.command?.env) {
    copy.command.env = Object.fromEntries(
      Object.entries(copy.command.env).map(([key, value]) => [key, shouldRedactKey(key) ? "[REDACTED]" : value]),
    );
  }
  return copy;
}

export function sanitizeChannelsForOutput(channels: ChannelConfig[]): ChannelConfig[] {
  return channels.map(sanitizeChannelForOutput);
}

export function redactSensitiveKeys<T extends EventEnvelope>(event: T, replacement = "[REDACTED]"): T {
  return redactValue(event, replacement) as T;
}

function shouldRedactKey(key: string): boolean {
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

function normalizeTime(value?: string | Date): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRetryPolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  return {
    maxAttempts: Math.max(1, policy?.maxAttempts ?? 1),
    backoffMs: Math.max(0, policy?.backoffMs ?? 250),
    multiplier: Math.max(1, policy?.multiplier ?? 2),
  };
}
