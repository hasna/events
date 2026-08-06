import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { channelMatchesEvent } from "./filter.js";
import { createEvent } from "./index.js";
import { redactPaths, redactSensitiveKeys } from "./redaction.js";
import { createDeliveryResult, dispatchChannel, type TransportDispatchOptions, type WebhookSecretResolver } from "./transports.js";
import type {
  ChannelConfig,
  DeliveryAttempt,
  DeliveryResult,
  EventEnvelope,
  EventInput,
  RetryPolicy,
  WebhookTransportConfig,
} from "./types.js";

const DURABLE_SCHEMA_VERSION = 1;
const MAX_RETRY_ATTEMPTS = 1_000;
const MAX_RETRY_DELAY_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_RETRY_MULTIPLIER = 100;
const REQUIRED_SCHEMA_OBJECTS = [
  "channels",
  "events",
  "events_dedupe_key_unique",
  "events_source_type_idx",
  "outbox",
  "outbox_due_idx",
  "deliveries",
] as const;

export interface DurableEventsBrokerOptions extends TransportDispatchOptions {
  dataDir: string;
  databaseName?: string;
  now?: () => Date;
}

export interface DurableEnqueueOptions {
  dedupe?: boolean;
}

export interface DurableEnqueueResult<TData extends Record<string, unknown> = Record<string, unknown>> {
  event: EventEnvelope<TData>;
  deduped: boolean;
  queued: number;
}

export interface DurableDrainOptions {
  workerId?: string;
  limit?: number;
  leaseMs?: number;
}

export interface DurableDrainResult {
  workerId: string;
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  lost: number;
  deliveries: DeliveryResult[];
}

export interface DurableSpoolImportOptions {
  limit?: number;
}

export interface DurableSpoolImportResult {
  scanned: number;
  imported: number;
  deduped: number;
  queued: number;
}

export interface DurableRetryDeadOptions {
  eventId?: string;
  channelId?: string;
  limit?: number;
}

export interface DurableRetryDeadResult {
  matched: number;
  requeued: number;
}

export type DurableOutboxStatus = "pending" | "leased" | "delivered" | "dead";

export interface DurableEventsStatus {
  service: "events";
  storage: "local-sqlite";
  schemaVersion: number;
  databasePath: string;
  counts: {
    channels: number;
    enabledChannels: number;
    events: number;
    pending: number;
    leased: number;
    delivered: number;
    dead: number;
  };
  safety: {
    statusOmitsEventPayloads: true;
    databasePersistsEventEnvelopes: true;
    includesResolvedSecrets: false;
    inlineWebhookSecretsAllowed: false;
  };
}

export interface DurableDeliveryJob {
  id: string;
  event: EventEnvelope;
  channel: ChannelConfig;
  attempt: number;
  workerId: string;
}

export interface DurableSettleResult {
  status: "delivered" | "retry" | "dead" | "lost";
  delivery?: DeliveryResult;
}

interface EventRow {
  envelope_json: string;
}

interface ChannelRow {
  config_json: string;
}

interface OutboxRow {
  id: string;
  event_json: string;
  channel_json: string;
  attempt_count: number;
  attempts_json: string;
}

interface CountRow {
  count: number;
}

interface StatusCountRow {
  status: DurableOutboxStatus;
  count: number;
}

export function defaultWebhookSecretResolver(reference: string): string | undefined {
  if (!reference.startsWith("env:")) throw new Error("Unsupported webhook secret reference scheme");
  const name = reference.slice("env:".length);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid webhook secret environment reference");
  return process.env[name];
}

export class DurableEventsBroker {
  readonly dataDir: string;
  readonly databasePath: string;
  private readonly db: Database;
  private readonly now: () => Date;
  private readonly transportOptions: TransportDispatchOptions;

  constructor(options: DurableEventsBrokerOptions) {
    if (!options.dataDir) throw new Error("DurableEventsBroker requires dataDir");
    this.dataDir = options.dataDir;
    this.databasePath = join(options.dataDir, options.databaseName ?? "events.sqlite");
    this.now = options.now ?? (() => new Date());
    this.transportOptions = {
      fetchImpl: options.fetchImpl,
      secretResolver: options.secretResolver ?? defaultWebhookSecretResolver,
      now: this.now,
    };
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    this.db = new Database(this.databasePath, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = FULL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.ensureSchema();
      this.secureDatabaseFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  addChannel(
    input: Omit<ChannelConfig, "createdAt" | "updatedAt"> & Partial<Pick<ChannelConfig, "createdAt" | "updatedAt">>,
  ): ChannelConfig {
    if (input.transport !== "webhook") {
      throw new Error("Durable SQLite channels support only webhook transport");
    }
    if (input.webhook?.secret !== undefined) {
      throw new Error("Durable SQLite channels reject inline webhook secrets; use webhook.secretRef");
    }
    if (input.transport === "webhook" && !input.webhook?.secretRef) {
      throw new Error("Durable SQLite webhook channels require webhook.secretRef");
    }
    if (input.webhook?.secretRef && !/^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(input.webhook.secretRef)) {
      throw new Error("Durable SQLite webhook secretRef must be a runtime reference");
    }
    if (input.webhook) validateDurableWebhookConfig(input.webhook);
    if (input.retry !== undefined) validateRetryPolicy(input.retry);
    const timestamp = this.now().toISOString();
    const existing = this.db.query("SELECT config_json FROM channels WHERE id = ?").get(input.id) as ChannelRow | null;
    const existingChannel = existing ? parseJson<ChannelConfig>(existing.config_json) : undefined;
    const channel: ChannelConfig = {
      ...input,
      createdAt: existingChannel?.createdAt ?? input.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.immediate(() => {
      this.db.query(`
        INSERT INTO channels (id, enabled, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `).run(channel.id, channel.enabled ? 1 : 0, JSON.stringify(channel), channel.createdAt, channel.updatedAt);
    });
    this.secureDatabaseFiles();
    return channel;
  }

  listChannels(): ChannelConfig[] {
    const rows = this.db.query("SELECT config_json FROM channels ORDER BY id").all() as ChannelRow[];
    return rows.map((row) => parseJson<ChannelConfig>(row.config_json));
  }

  enqueue<TData extends Record<string, unknown>>(
    input: EventInput<TData>,
    options: DurableEnqueueOptions = {},
  ): DurableEnqueueResult<TData> {
    const event = redactSensitiveKeys(createEvent({ ...input, time: input.time ?? this.now() }));
    const result = this.immediate(() => {
      if (options.dedupe !== false) {
        const existing = this.findEvent(event.id, event.dedupeKey);
        if (existing) {
          const storedEvent = parseJson<EventEnvelope<TData>>(existing.envelope_json);
          return {
            event: storedEvent,
            deduped: true,
            queued: this.queueMatchingChannels(storedEvent),
          };
        }
      }

      this.db.query(`
        INSERT INTO events (id, dedupe_key, source, type, time, envelope_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.dedupeKey ?? null,
        event.source,
        event.type,
        event.time,
        JSON.stringify(event),
        this.now().toISOString(),
      );

      const queued = this.queueMatchingChannels(event);
      return { event, deduped: false, queued };
    });
    this.secureDatabaseFiles();
    return result;
  }

  async drain(options: DurableDrainOptions = {}): Promise<DurableDrainResult> {
    const workerId = options.workerId ?? randomUUID();
    const limit = normalizePositiveInteger(options.limit, 100, "limit");
    const leaseMs = normalizePositiveInteger(options.leaseMs, 60_000, "leaseMs");
    const attemptedIds = new Set<string>();
    const summary: DurableDrainResult = {
      workerId,
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      lost: 0,
      deliveries: [],
    };
    while (summary.claimed < limit) {
      const [job] = this.claim({ workerId, limit: 1, leaseMs, excludeIds: [...attemptedIds] });
      if (!job) break;
      attemptedIds.add(job.id);
      summary.claimed += 1;
      let attempt: DeliveryAttempt;
      try {
        attempt = await dispatchChannel(job.event, job.channel, this.transportOptions);
      } catch {
        const timestamp = this.now().toISOString();
        attempt = {
          attempt: job.attempt,
          status: "failed",
          startedAt: timestamp,
          completedAt: timestamp,
          error: "Webhook delivery failed",
        };
      }
      attempt.attempt = job.attempt;
      attempt = sanitizeDurableAttempt(attempt);
      const settled = this.settle(job, attempt);
      if (settled.status === "delivered") summary.delivered += 1;
      if (settled.status === "retry") summary.retried += 1;
      if (settled.status === "dead") summary.dead += 1;
      if (settled.status === "lost") summary.lost += 1;
      if (settled.delivery) summary.deliveries.push(settled.delivery);
    }
    this.secureDatabaseFiles();
    return summary;
  }

  importSpool(options: DurableSpoolImportOptions = {}): DurableSpoolImportResult {
    const inboxDir = join(this.dataDir, "spool", "inbox");
    if (!existsSync(inboxDir)) return { scanned: 0, imported: 0, deduped: 0, queued: 0 };
    const limit = normalizePositiveInteger(options.limit, 100, "limit");
    const names = readdirSync(inboxDir)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort()
      .slice(0, limit);
    const result: DurableSpoolImportResult = { scanned: names.length, imported: 0, deduped: 0, queued: 0 };
    for (const name of names) {
      const path = join(inboxDir, name);
      let event: EventEnvelope;
      try {
        event = parseSpoolEnvelope(readFileSync(path, "utf8"));
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (spoolFileName(event) !== name) throw new Error("Durable event spool filename does not match its identity");
      const enqueued = this.enqueue(event);
      if (enqueued.deduped) result.deduped += 1;
      else result.imported += 1;
      result.queued += enqueued.queued;
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
    if (names.length > 0) syncDirectory(inboxDir);
    this.secureDatabaseFiles();
    return result;
  }

  retryDead(options: DurableRetryDeadOptions = {}): DurableRetryDeadResult {
    const limit = normalizePositiveInteger(options.limit, 100, "limit");
    return this.immediate(() => {
      const conditions = ["status = 'dead'"];
      const bindings: Array<string | number> = [];
      if (options.eventId) {
        conditions.push("event_id = ?");
        bindings.push(options.eventId);
      }
      if (options.channelId) {
        conditions.push("channel_id = ?");
        bindings.push(options.channelId);
      }
      const rows = this.db.query(`
        SELECT id FROM outbox
        WHERE ${conditions.join(" AND ")}
        ORDER BY updated_at, id
        LIMIT ?
      `).all(...bindings, limit) as Array<{ id: string }>;
      let requeued = 0;
      for (const row of rows) {
        const updated = this.db.query(`
          UPDATE outbox
          SET status = 'pending', attempt_count = 0, attempts_json = '[]',
              available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE id = ? AND status = 'dead'
        `).run(this.now().getTime(), this.now().toISOString(), row.id);
        requeued += Number(updated.changes);
      }
      return { matched: rows.length, requeued };
    });
  }

  status(): DurableEventsStatus {
    const channels = this.count("SELECT COUNT(*) AS count FROM channels");
    const enabledChannels = this.count("SELECT COUNT(*) AS count FROM channels WHERE enabled = 1");
    const events = this.count("SELECT COUNT(*) AS count FROM events");
    const statusRows = this.db.query("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all() as StatusCountRow[];
    const statuses = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)]));
    return {
      service: "events",
      storage: "local-sqlite",
      schemaVersion: DURABLE_SCHEMA_VERSION,
      databasePath: this.databasePath,
      counts: {
        channels,
        enabledChannels,
        events,
        pending: statuses.pending ?? 0,
        leased: statuses.leased ?? 0,
        delivered: statuses.delivered ?? 0,
        dead: statuses.dead ?? 0,
      },
      safety: {
        statusOmitsEventPayloads: true,
        databasePersistsEventEnvelopes: true,
        includesResolvedSecrets: false,
        inlineWebhookSecretsAllowed: false,
      },
    };
  }

  nextWakeAt(): number | undefined {
    const row = this.db.query(`
      SELECT MIN(
        CASE WHEN o.status = 'leased' THEN o.lease_expires_at ELSE o.available_at END
      ) AS next_at
      FROM outbox o
      JOIN channels c ON c.id = o.channel_id AND c.enabled = 1
      WHERE o.status IN ('pending', 'leased')
    `).get() as { next_at: number | null } | null;
    return row?.next_at === null || row?.next_at === undefined ? undefined : Number(row.next_at);
  }

  private claim(options: { workerId: string; limit: number; leaseMs: number; excludeIds?: string[] }): DurableDeliveryJob[] {
    return this.immediate(() => {
      const nowMs = this.now().getTime();
      const excludeIds = options.excludeIds ?? [];
      const exclusion = excludeIds.length > 0
        ? ` AND o.id NOT IN (${excludeIds.map(() => "?").join(", ")})`
        : "";
      const rows = this.db.query(`
        SELECT o.id, o.event_json, c.config_json AS channel_json,
               o.attempt_count, o.attempts_json
        FROM outbox o
        JOIN channels c ON c.id = o.channel_id AND c.enabled = 1
        WHERE ((o.status = 'pending' AND o.available_at <= ?)
           OR (o.status = 'leased' AND o.lease_expires_at <= ?))
          ${exclusion}
        ORDER BY o.available_at, o.created_at, o.id
        LIMIT ?
      `).all(nowMs, nowMs, ...excludeIds, options.limit) as OutboxRow[];
      const jobs: DurableDeliveryJob[] = [];
      for (const row of rows) {
        const nextAttempt = Number(row.attempt_count) + 1;
        const channel = parseJson<ChannelConfig>(row.channel_json);
        const transportTimeoutMs = channel.webhook?.timeoutMs ?? channel.command?.timeoutMs ?? 15_000;
        const leaseMs = Math.max(options.leaseMs, transportTimeoutMs + 5_000);
        const update = this.db.query(`
          UPDATE outbox
          SET status = 'leased', attempt_count = ?, lease_owner = ?,
              lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND ((status = 'pending' AND available_at <= ?)
              OR (status = 'leased' AND lease_expires_at <= ?))
        `).run(
          nextAttempt,
          options.workerId,
          nowMs + leaseMs,
          this.now().toISOString(),
          row.id,
          nowMs,
          nowMs,
        );
        if (Number(update.changes) !== 1) continue;
        jobs.push({
          id: row.id,
          event: parseJson<EventEnvelope>(row.event_json),
          channel,
          attempt: nextAttempt,
          workerId: options.workerId,
        });
      }
      return jobs;
    });
  }

  private settle(job: DurableDeliveryJob, attempt: DeliveryAttempt): DurableSettleResult {
    return this.immediate(() => {
      const row = this.db.query(`
        SELECT attempts_json FROM outbox
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
      `).get(job.id, job.workerId) as Pick<OutboxRow, "attempts_json"> | null;
      if (!row) return { status: "lost" };
      const attempts = parseJson<DeliveryAttempt[]>(row.attempts_json);
      attempts.push(attempt);
      if (attempt.status === "success") {
        const delivery = createDeliveryResult(job.event, job.channel, attempts);
        this.completeOutbox(job, "delivered", attempts, delivery);
        return { status: "delivered", delivery };
      }

      const retry = normalizeRetryPolicy(job.channel.retry);
      if (job.attempt < retry.maxAttempts) {
        const backoffMs = retryBackoffMs(retry, job.attempt);
        attempt.nextBackoffMs = backoffMs;
        this.db.query(`
          UPDATE outbox
          SET status = 'pending', available_at = ?, attempts_json = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND lease_owner = ?
        `).run(
          this.now().getTime() + backoffMs,
          JSON.stringify(attempts),
          this.now().toISOString(),
          job.id,
          job.workerId,
        );
        return { status: "retry" };
      }

      const delivery = createDeliveryResult(job.event, job.channel, attempts);
      this.completeOutbox(job, "dead", attempts, delivery);
      return { status: "dead", delivery };
    });
  }

  private completeOutbox(
    job: DurableDeliveryJob,
    status: Extract<DurableOutboxStatus, "delivered" | "dead">,
    attempts: DeliveryAttempt[],
    delivery: DeliveryResult,
  ): void {
    const timestamp = this.now().toISOString();
    this.db.query(`
      UPDATE outbox
      SET status = ?, attempts_json = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ?
    `).run(status, JSON.stringify(attempts), timestamp, job.id, job.workerId);
    this.db.query(`
      INSERT INTO deliveries (id, event_id, channel_id, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(delivery.id, job.event.id, job.channel.id, JSON.stringify(delivery), timestamp);
  }

  private findEvent(id: string, dedupeKey: string | undefined): EventRow | null {
    if (dedupeKey === undefined) {
      return this.db.query("SELECT envelope_json FROM events WHERE id = ? LIMIT 1").get(id) as EventRow | null;
    }
    return this.db.query(`
      SELECT envelope_json FROM events
      WHERE id = ? OR dedupe_key = ?
      LIMIT 1
    `).get(id, dedupeKey) as EventRow | null;
  }

  private queueMatchingChannels(event: EventEnvelope): number {
    const channels = this.db.query("SELECT config_json FROM channels WHERE enabled = 1 ORDER BY id").all() as ChannelRow[];
    let queued = 0;
    for (const row of channels) {
      const channel = parseJson<ChannelConfig>(row.config_json);
      if (!channelMatchesEvent(channel, event)) continue;
      const channelEvent = redactPaths(
        event,
        channel.redact?.paths ?? [],
        channel.redact?.replacement ?? "[REDACTED]",
      );
      const timestamp = this.now().toISOString();
      const inserted = this.db.query(`
        INSERT OR IGNORE INTO outbox (
          id, event_id, channel_id, event_json, channel_json, status,
          attempt_count, available_at, attempts_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, '[]', ?, ?)
      `).run(
        randomUUID(),
        event.id,
        channel.id,
        JSON.stringify(channelEvent),
        JSON.stringify(channel),
        this.now().getTime(),
        timestamp,
        timestamp,
      );
      queued += Number(inserted.changes);
    }
    return queued;
  }

  private count(sql: string): number {
    const row = this.db.query(sql).get() as CountRow | null;
    return Number(row?.count ?? 0);
  }

  private immediate<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureSchema(): void {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number } | null;
    const version = Number(row?.user_version);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error("Durable SQLite schema version is invalid");
    }
    if (version > DURABLE_SCHEMA_VERSION) {
      throw new Error(
        `Durable SQLite schema version ${version} is newer than supported version ${DURABLE_SCHEMA_VERSION}`,
      );
    }
    if (version === 0) {
      this.immediate(() => {
        this.createSchemaV1();
        this.db.exec(`PRAGMA user_version = ${DURABLE_SCHEMA_VERSION};`);
        this.assertSchemaV1();
      });
      return;
    }
    this.assertSchemaV1();
  }

  private createSchemaV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        time TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_key_unique
        ON events(dedupe_key) WHERE dedupe_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_source_type_idx ON events(source, type);

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id),
        channel_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        channel_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'dead')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        attempts_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(event_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox(status, available_at, lease_expires_at);

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id),
        channel_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

    `);
  }

  private assertSchemaV1(): void {
    const rows = this.db.query(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index') AND name IN (${REQUIRED_SCHEMA_OBJECTS.map(() => "?").join(", ")})
    `).all(...REQUIRED_SCHEMA_OBJECTS) as Array<{ name: string }>;
    const found = new Set(rows.map((row) => row.name));
    const missing = REQUIRED_SCHEMA_OBJECTS.filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`Durable SQLite schema version 1 is incomplete: missing ${missing.join(", ")}`);
    }
  }

  private secureDatabaseFiles(): void {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      chmodSync(path, 0o600);
    }
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function normalizeRetryPolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  const normalized = {
    maxAttempts: policy?.maxAttempts ?? 1,
    backoffMs: policy?.backoffMs ?? 250,
    multiplier: policy?.multiplier ?? 2,
  };
  validateRetryPolicy(normalized);
  return normalized;
}

function validateRetryPolicy(policy: RetryPolicy): void {
  const maxAttempts = policy.maxAttempts ?? 1;
  const backoffMs = policy.backoffMs ?? 250;
  const multiplier = policy.multiplier ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new Error(`retry.maxAttempts must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}`);
  }
  if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > MAX_RETRY_DELAY_MS) {
    throw new Error(`retry.backoffMs must be an integer from 0 to ${MAX_RETRY_DELAY_MS}`);
  }
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > MAX_RETRY_MULTIPLIER) {
    throw new Error(`retry.multiplier must be finite and from 1 to ${MAX_RETRY_MULTIPLIER}`);
  }
  if (maxAttempts > 1) retryBackoffMs({ maxAttempts, backoffMs, multiplier }, maxAttempts - 1);
}

function retryBackoffMs(policy: Required<RetryPolicy>, attempt: number): number {
  const delay = Math.round(policy.backoffMs * policy.multiplier ** (attempt - 1));
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_RETRY_DELAY_MS) {
    throw new Error(`retry policy must not produce a delay above ${MAX_RETRY_DELAY_MS}ms`);
  }
  return delay;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function validateDurableWebhookConfig(webhook: WebhookTransportConfig): void {
  let url: URL;
  try {
    url = new URL(webhook.url);
  } catch {
    throw new Error("Durable webhook URL must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Durable webhook URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Durable webhook URL must not contain credentials");
  }
  for (const name of url.searchParams.keys()) {
    if (/authorization|cookie|api[-_]?key|token|secret|credential|signature/i.test(name)) {
      throw new Error("Durable webhook URL must not contain credential query parameters");
    }
  }
  for (const name of Object.keys(webhook.headers ?? {})) {
    if (/^x-hasna-/i.test(name)) {
      throw new Error("Durable webhook X-Hasna headers are reserved for signed delivery metadata");
    }
    if (/authorization|cookie|api[-_]?key|token|secret|credential/i.test(name)) {
      throw new Error("Durable webhook credential headers are not persisted; use webhook.secretRef");
    }
  }
}

function sanitizeDurableAttempt(attempt: DeliveryAttempt): DeliveryAttempt {
  const { responseBody: _responseBody, stdout: _stdout, stderr: _stderr, ...metadata } = attempt;
  if (metadata.status === "failed") {
    metadata.error = metadata.responseStatus === undefined
      ? "Webhook delivery failed"
      : `Webhook returned HTTP ${metadata.responseStatus}`;
  }
  return metadata;
}

function parseSpoolEnvelope(raw: string): EventEnvelope {
  const value = parseJson<Partial<EventEnvelope>>(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid durable event spool record");
  for (const field of ["id", "source", "type", "time", "schemaVersion"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error("Invalid durable event spool record");
    }
  }
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    throw new Error("Invalid durable event spool record");
  }
  if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) {
    throw new Error("Invalid durable event spool record");
  }
  return value as EventEnvelope;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function spoolFileName(event: Pick<EventEnvelope, "id" | "dedupeKey">): string {
  const identity = event.dedupeKey ?? event.id;
  return `${createHash("sha256").update(identity, "utf8").digest("hex")}.json`;
}
