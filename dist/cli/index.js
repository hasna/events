#!/usr/bin/env bun
// @bun

// src/cli/index.ts
import { readFileSync as readFileSync2 } from "fs";
import { dirname, join as join5 } from "path";
import { fileURLToPath } from "url";

// src/index.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/filter.ts
function getPathValue(input, path) {
  return path.split(".").reduce((value, part) => {
    if (value && typeof value === "object" && part in value) {
      return value[part];
    }
    return;
  }, input);
}
function getFieldValues(input, path) {
  const values = [];
  const push = (value) => {
    if (!values.some((item) => Object.is(item, value)))
      values.push(value);
  };
  if (path.includes(".") && path in input)
    push(input[path]);
  const nestedValue = getPathValue(input, path);
  if (nestedValue !== undefined || !path.includes("."))
    push(nestedValue);
  return values;
}
function wildcardToRegExp(pattern, options = {}) {
  let body = "";
  for (let index = 0;index < pattern.length; index += 1) {
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
function matchString(value, matcher, options = {}) {
  if (matcher === undefined)
    return true;
  if (value === undefined)
    return false;
  const matchers = Array.isArray(matcher) ? matcher : [matcher];
  return matchers.some((item) => wildcardToRegExp(item, options).test(value));
}
function matchRecord(input, matcher) {
  if (!matcher)
    return true;
  return Object.entries(matcher).every(([path, expected]) => {
    const actualValues = getFieldValues(input, path);
    return matchField(actualValues, expected, path);
  });
}
function matchField(actualValues, expected, path) {
  if (isNegativeMatcher(expected)) {
    return !actualValues.some((actual) => matchPositiveField(actual, expected.not, path));
  }
  return actualValues.some((actual) => matchPositiveField(actual, expected, path));
}
function matchPositiveField(actual, expected, path) {
  if (typeof expected === "string" || Array.isArray(expected)) {
    return stringCandidates(actual).some((candidate) => matchString(candidate, expected, {
      segmentSafe: path.endsWith("_path") || path.endsWith(".path")
    }));
  }
  if (Array.isArray(actual)) {
    return actual.some((item) => item === expected);
  }
  return actual === expected;
}
function stringCandidates(actual) {
  if (actual === undefined)
    return [];
  if (Array.isArray(actual)) {
    return actual.flatMap((item) => isPrimitiveFieldValue(item) ? [String(item)] : []);
  }
  return [String(actual)];
}
function isPrimitiveFieldValue(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function isNegativeMatcher(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "not" in value);
}
function eventMatchesFilter(event, filter) {
  return matchString(event.source, filter.source) && matchString(event.type, filter.type) && matchString(event.subject, filter.subject) && matchString(event.severity, filter.severity) && matchRecord(event.data, filter.data) && matchRecord(event.metadata, filter.metadata);
}
function channelMatchesEvent(channel, event) {
  if (!channel.enabled)
    return false;
  if (!channel.filters || channel.filters.length === 0)
    return true;
  return channel.filters.some((filter) => eventMatchesFilter(event, filter));
}

// src/storage.ts
import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { Buffer as Buffer2 } from "buffer";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var HASNA_EVENTS_DIR_ENV = "HASNA_EVENTS_DIR";
var HASNA_EVENTS_HOME_ENV = "HASNA_EVENTS_HOME";
var LOCAL_JSON_EVENT_CURSOR_PREFIX = "local-json-v1:";
var DEFAULT_EVENT_PAGE_LIMIT = 100;
var MAX_EVENT_PAGE_LIMIT = 1000;
function getEventsDataDir(override) {
  return override || process.env[HASNA_EVENTS_DIR_ENV] || process.env[HASNA_EVENTS_HOME_ENV] || join(homedir(), ".hasna", "events");
}
function getActiveEventsDirEnv() {
  if (process.env[HASNA_EVENTS_DIR_ENV])
    return HASNA_EVENTS_DIR_ENV;
  if (process.env[HASNA_EVENTS_HOME_ENV])
    return HASNA_EVENTS_HOME_ENV;
  return null;
}

class JsonEventsStore {
  dataDir;
  runtime;
  channelsPath;
  eventsPath;
  deliveriesPath;
  constructor(dataDir = getEventsDataDir()) {
    this.dataDir = dataDir;
    this.runtime = localJsonRuntime(dataDir);
    this.channelsPath = join(dataDir, "channels.json");
    this.eventsPath = join(dataDir, "events.json");
    this.deliveriesPath = join(dataDir, "deliveries.json");
  }
  async init() {
    await mkdir(this.dataDir, { recursive: true, mode: 448 });
    await chmod(this.dataDir, 448).catch(() => {
      return;
    });
    await this.ensureArrayFile(this.channelsPath);
    await this.ensureArrayFile(this.eventsPath);
    await this.ensureArrayFile(this.deliveriesPath);
  }
  async addChannel(channel) {
    await this.init();
    const channels = await this.readJson(this.channelsPath, []);
    const index = channels.findIndex((item) => item.id === channel.id);
    if (index >= 0) {
      channels[index] = { ...channel, createdAt: channels[index].createdAt, updatedAt: new Date().toISOString() };
    } else {
      channels.push(channel);
    }
    await this.writeJson(this.channelsPath, channels);
    return index >= 0 ? channels[index] : channel;
  }
  async listChannels() {
    await this.init();
    return this.readJson(this.channelsPath, []);
  }
  async getChannel(id) {
    const channels = await this.listChannels();
    return channels.find((channel) => channel.id === id);
  }
  async removeChannel(id) {
    await this.init();
    const channels = await this.readJson(this.channelsPath, []);
    const next = channels.filter((channel) => channel.id !== id);
    await this.writeJson(this.channelsPath, next);
    return next.length !== channels.length;
  }
  async appendEvent(event) {
    await this.init();
    const events = await this.readJson(this.eventsPath, []);
    events.push(event);
    await this.writeJson(this.eventsPath, events);
    return event;
  }
  async appendEventOnce(event, options = {}) {
    await this.init();
    const events = await this.readJson(this.eventsPath, []);
    const dedupe = options.dedupe !== false;
    if (dedupe) {
      const existing = findEventByIdentity(events, { id: event.id, dedupeKey: event.dedupeKey });
      if (existing) {
        return {
          event: existing,
          stored: false,
          deduped: true,
          identity: { id: existing.id, dedupeKey: existing.dedupeKey }
        };
      }
    }
    events.push(event);
    await this.writeJson(this.eventsPath, events);
    return {
      event,
      stored: true,
      deduped: false,
      identity: { id: event.id, dedupeKey: event.dedupeKey }
    };
  }
  async listEvents(options = {}) {
    await this.init();
    const events = await this.readJson(this.eventsPath, []);
    return queryEvents(events, options);
  }
  async listEventsPage(options = {}) {
    await this.init();
    const events = await this.readJson(this.eventsPath, []);
    const queried = queryEvents(events, {
      eventId: options.eventId,
      source: options.source,
      type: options.type
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
      hasMore
    };
  }
  async findEventByIdentity(identity) {
    const events = await this.listEvents();
    return findEventByIdentity(events, identity);
  }
  async appendDelivery(result) {
    await this.init();
    const deliveries = await this.readJson(this.deliveriesPath, []);
    deliveries.push(result);
    await this.writeJson(this.deliveriesPath, deliveries);
    return result;
  }
  async listDeliveries() {
    await this.init();
    return this.readJson(this.deliveriesPath, []);
  }
  async exportData() {
    return {
      channels: await this.listChannels(),
      events: await this.listEvents(),
      deliveries: await this.listDeliveries()
    };
  }
  async ensureArrayFile(path) {
    if (!existsSync(path)) {
      await writeFile(path, `[]
`, { encoding: "utf-8", mode: 384 });
    }
    await chmod(path, 384).catch(() => {
      return;
    });
  }
  async readJson(path, fallback) {
    try {
      const raw = await readFile(path, "utf-8");
      if (!raw.trim())
        return fallback;
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT")
        return fallback;
      throw error;
    }
  }
  async writeJson(path, value) {
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf-8", mode: 384 });
    await rename(tempPath, path);
    await chmod(path, 384).catch(() => {
      return;
    });
  }
}
function localJsonRuntime(dataDir = getEventsDataDir()) {
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
    description: `Local JSON files in ${dataDir}; no SQLite, Postgres, S3, or AWS runtime is configured by this store.`
  };
}
function encodeLocalJsonEventCursor(offset, options = {}) {
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error(`Invalid event cursor offset: ${offset}`);
  const payload = {
    offset,
    eventId: options.eventId,
    source: options.source,
    type: options.type
  };
  return `${LOCAL_JSON_EVENT_CURSOR_PREFIX}${Buffer2.from(JSON.stringify(payload), "utf-8").toString("base64url")}`;
}
function decodeLocalJsonEventCursor(cursor, options = {}) {
  if (!cursor)
    return 0;
  if (!cursor.startsWith(LOCAL_JSON_EVENT_CURSOR_PREFIX))
    throw new Error(`Invalid local JSON event cursor: ${cursor}`);
  const rawPayload = cursor.slice(LOCAL_JSON_EVENT_CURSOR_PREFIX.length);
  let payload;
  try {
    payload = JSON.parse(Buffer2.from(rawPayload, "base64url").toString("utf-8"));
  } catch {
    throw new Error(`Invalid local JSON event cursor: ${cursor}`);
  }
  const offset = payload.offset;
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error(`Invalid local JSON event cursor: ${cursor}`);
  assertCursorFilter("eventId", payload.eventId, options.eventId);
  assertCursorFilter("source", payload.source, options.source);
  assertCursorFilter("type", payload.type, options.type);
  return offset;
}
function normalizeEventPageLimit(limit) {
  if (limit === undefined)
    return DEFAULT_EVENT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(`Event page limit must be a positive integer, got ${limit}`);
  return Math.min(limit, MAX_EVENT_PAGE_LIMIT);
}
function queryEvents(events, options) {
  let rows = events;
  if (options.eventId)
    rows = rows.filter((event) => event.id === options.eventId);
  if (options.source)
    rows = rows.filter((event) => event.source === options.source);
  if (options.type)
    rows = rows.filter((event) => event.type === options.type);
  if (options.cursor) {
    const offset = decodeLocalJsonEventCursor(options.cursor, options);
    rows = rows.slice(offset);
  }
  if (options.limit !== undefined)
    rows = rows.slice(0, normalizeEventPageLimit(options.limit));
  return rows;
}
function assertCursorFilter(name, cursorValue, optionValue) {
  if (cursorValue !== optionValue)
    throw new Error(`Local JSON event cursor ${name} filter mismatch`);
}
function findEventByIdentity(events, identity) {
  return events.find((event) => identity.id !== undefined && event.id === identity.id || identity.dedupeKey !== undefined && event.dedupeKey === identity.dedupeKey);
}
async function getEventsStatus(dataDir) {
  const store = new JsonEventsStore(dataDir);
  await store.init();
  const [channels, events, deliveries] = await Promise.all([
    store.listChannels(),
    store.listEvents(),
    store.listDeliveries()
  ]);
  const transports = channels.reduce((counts, channel) => {
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
      active: getActiveEventsDirEnv()
    },
    files: {
      channels: statusFile(store.dataDir, "channels.json", channels.length),
      events: statusFile(store.dataDir, "events.json", events.length),
      deliveries: statusFile(store.dataDir, "deliveries.json", deliveries.length)
    },
    counts: {
      channels: channels.length,
      enabledChannels: channels.filter((channel) => channel.enabled).length,
      disabledChannels: channels.filter((channel) => !channel.enabled).length,
      events: events.length,
      deliveries: deliveries.length
    },
    transports,
    safety: {
      includesEventPayloads: false,
      includesWebhookSecrets: false,
      listOutputsRedactSecrets: true,
      statusOutputIsMetadataOnly: true
    }
  };
}
function statusFile(dataDir, fileName, records) {
  const path = join(dataDir, fileName);
  return { path, exists: existsSync(path), records };
}

// src/transports.ts
import { randomUUID } from "crypto";
import { spawn } from "child_process";

// src/signing.ts
import { createHmac, timingSafeEqual } from "crypto";
var DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
function buildSignatureBase(timestamp, body) {
  return `${timestamp}.${body}`;
}
function signPayload(secret, timestamp, body) {
  const digest = createHmac("sha256", secret).update(buildSignatureBase(timestamp, body)).digest("hex");
  return `sha256=${digest}`;
}

// src/transports.ts
function now() {
  return new Date().toISOString();
}
function truncate(value, max = 4096) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
function buildWebhookRequest(event, channel, options = {}) {
  if (!channel.webhook)
    throw new Error(`Channel ${channel.id} has no webhook config`);
  const body = JSON.stringify(event);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "@hasna/events",
    "X-Hasna-Event-Id": event.id,
    "X-Hasna-Event-Type": event.type,
    "X-Hasna-Timestamp": timestamp,
    ...channel.webhook.headers
  };
  const secret = options.secret ?? channel.webhook.secret;
  if (secret) {
    headers["X-Hasna-Signature"] = signPayload(secret, timestamp, body);
  }
  return { body, headers };
}
async function dispatchWebhook(event, channel, options = {}) {
  if (!channel.webhook)
    throw new Error(`Channel ${channel.id} has no webhook config`);
  const startedAt = now();
  let secret = channel.webhook.secret;
  if (channel.webhook.secretRef) {
    if (!options.secretResolver) {
      return failedAttempt(startedAt, "Webhook secret reference has no runtime resolver");
    }
    try {
      secret = await options.secretResolver(channel.webhook.secretRef);
    } catch {
      return failedAttempt(startedAt, "Webhook secret reference could not be resolved");
    }
    if (!secret)
      return failedAttempt(startedAt, "Webhook secret reference could not be resolved");
  }
  const timestamp = (options.now?.() ?? new Date).toISOString();
  const { body, headers } = buildWebhookRequest(event, channel, { secret, timestamp });
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), channel.webhook.timeoutMs ?? 15000);
  try {
    const response = await (options.fetchImpl ?? fetch)(channel.webhook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    const responseBody = truncate(await response.text());
    return {
      attempt: 1,
      status: response.ok ? "success" : "failed",
      startedAt,
      completedAt: now(),
      responseStatus: response.status,
      responseBody,
      error: response.ok ? undefined : `Webhook returned HTTP ${response.status}`
    };
  } catch (error) {
    return {
      attempt: 1,
      status: "failed",
      startedAt,
      completedAt: now(),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}
function failedAttempt(startedAt, error) {
  return {
    attempt: 1,
    status: "failed",
    startedAt,
    completedAt: now(),
    error
  };
}
async function dispatchCommand(event, channel) {
  if (!channel.command)
    throw new Error(`Channel ${channel.id} has no command config`);
  const startedAt = now();
  const eventJson = JSON.stringify(event);
  const env = {
    ...process.env,
    ...channel.command.env,
    HASNA_CHANNEL_ID: channel.id,
    HASNA_EVENT_ID: event.id,
    HASNA_EVENT_TYPE: event.type,
    HASNA_EVENT_SOURCE: event.source,
    HASNA_EVENT_SUBJECT: event.subject ?? "",
    HASNA_EVENT_SEVERITY: event.severity,
    HASNA_EVENT_TIME: event.time,
    HASNA_EVENT_DEDUPE_KEY: event.dedupeKey ?? "",
    HASNA_EVENT_SCHEMA_VERSION: event.schemaVersion,
    HASNA_EVENT_JSON: eventJson
  };
  return new Promise((resolve) => {
    const child = spawn(channel.command.command, channel.command.args ?? [], {
      cwd: channel.command.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), channel.command.timeoutMs ?? 15000);
    child.stdin.end(eventJson);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        attempt: 1,
        status: "failed",
        startedAt,
        completedAt: now(),
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        error: error.message
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const success = code === 0;
      resolve({
        attempt: 1,
        status: success ? "success" : "failed",
        startedAt,
        completedAt: now(),
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        error: success ? undefined : `Command exited with ${signal ? `signal ${signal}` : `code ${code}`}`
      });
    });
  });
}
async function dispatchChannel(event, channel, options = {}) {
  if (channel.transport === "webhook")
    return dispatchWebhook(event, channel, options);
  if (channel.transport === "command")
    return dispatchCommand(event, channel);
  return {
    attempt: 1,
    status: "skipped",
    startedAt: now(),
    completedAt: now(),
    error: `Unsupported transport: ${channel.transport}`
  };
}
function createDeliveryResult(event, channel, attempts) {
  const status = attempts.some((attempt) => attempt.status === "success") ? "success" : attempts.every((attempt) => attempt.status === "skipped") ? "skipped" : "failed";
  return {
    id: randomUUID(),
    eventId: event.id,
    channelId: channel.id,
    transport: channel.transport,
    status,
    attempts,
    createdAt: attempts[0]?.startedAt ?? now(),
    completedAt: attempts.at(-1)?.completedAt ?? now()
  };
}

// src/catalog.ts
class EventValidationError extends Error {
  eventType;
  issues;
  constructor(eventType, issues) {
    const detail = issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
    super(`Event validation failed for type "${eventType}": ${detail}`);
    this.name = "EventValidationError";
    this.eventType = eventType;
    this.issues = issues;
  }
}

class EventTypeCatalog {
  definitions = new Map;
  register(definition) {
    this.definitions.set(definition.type, definition);
    return this;
  }
  unregister(type) {
    return this.definitions.delete(type);
  }
  has(type) {
    return this.definitions.has(type);
  }
  get(type) {
    return this.definitions.get(type);
  }
  list() {
    return [...this.definitions.values()];
  }
  validateEvent(event) {
    const definition = this.definitions.get(event.type);
    if (!definition)
      return { ok: true };
    return definition.validate(event.data, event);
  }
  assertEventValid(event) {
    const result = this.validateEvent(event);
    if (!result.ok) {
      throw new EventValidationError(event.type, result.issues);
    }
  }
}
var defaultEventTypeCatalog = new EventTypeCatalog;
// src/app-event.ts
var APP_EVENT_V1_MAX_DATA_BYTES = 32 * 1024;

// src/index.ts
function createEvent(input) {
  return {
    id: input.id ?? randomUUID2(),
    source: input.source,
    type: input.type,
    time: normalizeTime(input.time),
    subject: input.subject,
    severity: input.severity ?? "info",
    data: input.data ?? {},
    message: input.message,
    dedupeKey: input.dedupeKey,
    schemaVersion: input.schemaVersion ?? "1.0",
    metadata: input.metadata ?? {}
  };
}

class EventsClient {
  store;
  redactors;
  transportOptions;
  catalog;
  validateCatalogTypes;
  constructor(options = {}) {
    this.store = options.store ?? new JsonEventsStore(options.dataDir);
    this.redactors = options.redactors ?? [];
    this.transportOptions = {
      fetchImpl: options.fetchImpl,
      secretResolver: options.secretResolver,
      now: options.now
    };
    this.catalog = options.catalog ?? defaultEventTypeCatalog;
    this.validateCatalogTypes = options.validateCatalogTypes ?? false;
  }
  async addChannel(input) {
    const timestamp = new Date().toISOString();
    return this.store.addChannel({
      ...input,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    });
  }
  async listChannels() {
    return this.store.listChannels();
  }
  async removeChannel(id) {
    return this.store.removeChannel(id);
  }
  async emit(input, options = {}) {
    const event = options.redactSensitiveData === false ? createEvent(input) : redactSensitiveKeys(createEvent(input));
    if (options.validate ?? this.validateCatalogTypes) {
      this.catalog.assertEventValid(event);
    }
    const append = await this.appendEvent(event, { dedupe: options.dedupe !== false });
    if (append.deduped) {
      return { event: append.event, deliveries: [], deduped: true };
    }
    const deliveries = options.deliver === false ? [] : await this.deliver(append.event);
    return { event: append.event, deliveries, deduped: false };
  }
  async listEvents(options = {}) {
    if (Object.keys(options).length === 0)
      return this.store.listEvents();
    return queryClientEvents(await this.store.listEvents(), options);
  }
  async listEventsPage(options = {}) {
    if (this.store.listEventsPage)
      return this.store.listEventsPage(options);
    const events = queryClientEvents(await this.store.listEvents(), {
      eventId: options.eventId,
      source: options.source,
      type: options.type
    });
    const offset = decodeLocalJsonEventCursor(options.cursor, options);
    const limit = normalizeEventPageLimit(options.limit);
    const pageEvents = events.slice(offset, offset + limit);
    const nextOffset = offset + pageEvents.length;
    const hasMore = nextOffset < events.length;
    return {
      events: pageEvents,
      cursor: options.cursor,
      nextCursor: hasMore ? encodeLocalJsonEventCursor(nextOffset, options) : undefined,
      hasMore
    };
  }
  async listDeliveries() {
    return this.store.listDeliveries();
  }
  async deliver(event) {
    const channels = await this.store.listChannels();
    const selected = channels.filter((channel) => channelMatchesEvent(channel, event));
    const deliveries = [];
    for (const channel of selected) {
      const eventForChannel = await this.applyRedaction(event, channel);
      const result = await this.deliverWithRetry(eventForChannel, channel);
      await this.store.appendDelivery(result);
      deliveries.push(result);
    }
    return deliveries;
  }
  async matchChannel(id, input = {}) {
    const channel = await this.store.getChannel(id);
    if (!channel)
      throw new Error(`Channel not found: ${id}`);
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
      id: input.id
    });
    const matched = channelMatchesEvent(channel, event);
    return {
      channelId: channel.id,
      matched,
      event,
      filters: channel.filters,
      reason: matched ? undefined : channel.enabled ? "event did not match channel filters" : "channel is disabled"
    };
  }
  async testChannel(id, input = {}, options = {}) {
    const channel = await this.store.getChannel(id);
    if (!channel)
      throw new Error(`Channel not found: ${id}`);
    const match = await this.matchChannel(id, input);
    const event = match.event;
    if (options.honorFilters && !match.matched) {
      const timestamp = new Date().toISOString();
      const result2 = createDeliveryResult(event, channel, [{
        attempt: 1,
        status: "skipped",
        startedAt: timestamp,
        completedAt: timestamp,
        error: match.reason
      }]);
      result2.metadata = { reason: "filter_mismatch" };
      await this.store.appendDelivery(result2);
      return result2;
    }
    const eventForChannel = await this.applyRedaction(event, channel);
    const result = await this.deliverWithRetry(eventForChannel, channel);
    await this.store.appendDelivery(result);
    return result;
  }
  async replay(options = {}) {
    const page = options.cursor || options.limit !== undefined ? await this.listEventsPage(options) : { events: await this.listEvents(options), hasMore: false };
    if (options.dryRun)
      return { events: page.events, deliveries: [], cursor: page.cursor, nextCursor: page.nextCursor, hasMore: page.hasMore };
    const deliveries = [];
    for (const event of page.events) {
      deliveries.push(...await this.deliver(event));
    }
    return { events: page.events, deliveries, cursor: page.cursor, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }
  async appendEvent(event, options) {
    if (this.store.appendEventOnce) {
      return this.store.appendEventOnce(event, { dedupe: options.dedupe });
    }
    if (options.dedupe) {
      const existing = await this.store.findEventByIdentity({ id: event.id, dedupeKey: event.dedupeKey });
      if (existing) {
        return {
          event: existing,
          stored: false,
          deduped: true,
          identity: { id: existing.id, dedupeKey: existing.dedupeKey }
        };
      }
    }
    const stored = await this.store.appendEvent(event);
    return {
      event: stored,
      stored: true,
      deduped: false,
      identity: { id: stored.id, dedupeKey: stored.dedupeKey }
    };
  }
  async applyRedaction(event, channel) {
    let next = redactPaths(event, channel.redact?.paths ?? [], channel.redact?.replacement ?? "[REDACTED]");
    for (const redactor of this.redactors) {
      next = await redactor(next, channel);
    }
    return next;
  }
  async deliverWithRetry(event, channel) {
    const policy = normalizeRetryPolicy(channel.retry);
    const attempts = [];
    for (let index = 0;index < policy.maxAttempts; index += 1) {
      const attempt = await dispatchChannel(event, channel, this.transportOptions);
      attempt.attempt = index + 1;
      if (attempt.status === "failed" && index + 1 < policy.maxAttempts) {
        attempt.nextBackoffMs = Math.round(policy.backoffMs * policy.multiplier ** index);
      }
      attempts.push(attempt);
      if (attempt.status !== "failed")
        break;
      if (attempt.nextBackoffMs)
        await Bun.sleep(attempt.nextBackoffMs);
    }
    return createDeliveryResult(event, channel, attempts);
  }
}
function redactPaths(event, paths, replacement = "[REDACTED]") {
  if (paths.length === 0)
    return event;
  const copy = structuredClone(event);
  for (const path of paths) {
    setPath(copy, path, replacement);
  }
  return copy;
}
function sanitizeChannelForOutput(channel) {
  const copy = structuredClone(channel);
  if (copy.webhook?.secret)
    copy.webhook.secret = "[REDACTED]";
  if (copy.command?.env) {
    copy.command.env = Object.fromEntries(Object.entries(copy.command.env).map(([key, value]) => [key, shouldRedactKey(key) ? "[REDACTED]" : value]));
  }
  return copy;
}
function sanitizeChannelsForOutput(channels) {
  return channels.map(sanitizeChannelForOutput);
}
function redactSensitiveKeys(event, replacement = "[REDACTED]") {
  return redactValue(event, replacement);
}
function shouldRedactKey(key) {
  return /secret|token|password|api[_-]?key|authorization/i.test(key);
}
function redactValue(value, replacement) {
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, replacement));
  if (!value || typeof value !== "object")
    return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    shouldRedactKey(key) ? replacement : redactValue(item, replacement)
  ]));
}
function setPath(input, path, replacement) {
  const parts = path.split(".");
  let cursor = input;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object")
      return;
    cursor = next;
  }
  const last = parts.at(-1);
  if (last && last in cursor)
    cursor[last] = replacement;
}
function queryClientEvents(events, options) {
  let rows = events;
  if (options.eventId)
    rows = rows.filter((event) => event.id === options.eventId);
  if (options.source)
    rows = rows.filter((event) => event.source === options.source);
  if (options.type)
    rows = rows.filter((event) => event.type === options.type);
  if (options.cursor)
    rows = rows.slice(decodeLocalJsonEventCursor(options.cursor, options));
  if (options.limit !== undefined)
    rows = rows.slice(0, normalizeEventPageLimit(options.limit));
  return rows;
}
function normalizeTime(value) {
  if (!value)
    return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : value;
}
function normalizeRetryPolicy(policy) {
  return {
    maxAttempts: Math.max(1, policy?.maxAttempts ?? 1),
    backoffMs: Math.max(0, policy?.backoffMs ?? 250),
    multiplier: Math.max(1, policy?.multiplier ?? 2)
  };
}

// src/durable.ts
import { Database } from "bun:sqlite";
import { createHash, randomUUID as randomUUID3 } from "crypto";
import {
  chmodSync,
  closeSync,
  existsSync as existsSync2,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync
} from "fs";
import { join as join2 } from "path";
var DURABLE_SCHEMA_VERSION = 1;
function defaultWebhookSecretResolver(reference) {
  if (!reference.startsWith("env:"))
    throw new Error("Unsupported webhook secret reference scheme");
  const name = reference.slice("env:".length);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error("Invalid webhook secret environment reference");
  return process.env[name];
}

class DurableEventsBroker {
  dataDir;
  databasePath;
  db;
  now;
  transportOptions;
  constructor(options) {
    if (!options.dataDir)
      throw new Error("DurableEventsBroker requires dataDir");
    this.dataDir = options.dataDir;
    this.databasePath = join2(options.dataDir, options.databaseName ?? "events.sqlite");
    this.now = options.now ?? (() => new Date);
    this.transportOptions = {
      fetchImpl: options.fetchImpl,
      secretResolver: options.secretResolver ?? defaultWebhookSecretResolver,
      now: this.now
    };
    mkdirSync(this.dataDir, { recursive: true, mode: 448 });
    chmodSync(this.dataDir, 448);
    this.db = new Database(this.databasePath, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.ensureSchema();
    this.secureDatabaseFiles();
  }
  close() {
    this.db.close();
  }
  addChannel(input) {
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
    if (input.webhook)
      validateDurableWebhookConfig(input.webhook);
    const timestamp = this.now().toISOString();
    const existing = this.db.query("SELECT config_json FROM channels WHERE id = ?").get(input.id);
    const existingChannel = existing ? parseJson(existing.config_json) : undefined;
    const channel = {
      ...input,
      createdAt: existingChannel?.createdAt ?? input.createdAt ?? timestamp,
      updatedAt: timestamp
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
  listChannels() {
    const rows = this.db.query("SELECT config_json FROM channels ORDER BY id").all();
    return rows.map((row) => parseJson(row.config_json));
  }
  enqueue(input, options = {}) {
    const event = createEvent({ ...input, time: input.time ?? this.now() });
    const result = this.immediate(() => {
      if (options.dedupe !== false) {
        const existing = this.findEvent(event.id, event.dedupeKey);
        if (existing) {
          const storedEvent = parseJson(existing.envelope_json);
          return {
            event: storedEvent,
            deduped: true,
            queued: this.queueMatchingChannels(storedEvent)
          };
        }
      }
      this.db.query(`
        INSERT INTO events (id, dedupe_key, source, type, time, envelope_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.id, event.dedupeKey ?? null, event.source, event.type, event.time, JSON.stringify(event), this.now().toISOString());
      const queued = this.queueMatchingChannels(event);
      return { event, deduped: false, queued };
    });
    this.secureDatabaseFiles();
    return result;
  }
  async drain(options = {}) {
    const workerId = options.workerId ?? randomUUID3();
    const jobs = this.claim({
      workerId,
      limit: normalizePositiveInteger(options.limit, 100, "limit"),
      leaseMs: normalizePositiveInteger(options.leaseMs, 60000, "leaseMs")
    });
    const summary = {
      workerId,
      claimed: jobs.length,
      delivered: 0,
      retried: 0,
      dead: 0,
      deliveries: []
    };
    for (const job of jobs) {
      let attempt;
      try {
        attempt = await dispatchChannel(job.event, job.channel, this.transportOptions);
      } catch {
        const timestamp = this.now().toISOString();
        attempt = {
          attempt: job.attempt,
          status: "failed",
          startedAt: timestamp,
          completedAt: timestamp,
          error: "Webhook delivery failed"
        };
      }
      attempt.attempt = job.attempt;
      attempt = sanitizeDurableAttempt(attempt);
      const settled = this.settle(job, attempt);
      if (settled.status === "delivered")
        summary.delivered += 1;
      if (settled.status === "retry")
        summary.retried += 1;
      if (settled.status === "dead")
        summary.dead += 1;
      if (settled.delivery)
        summary.deliveries.push(settled.delivery);
    }
    this.secureDatabaseFiles();
    return summary;
  }
  importSpool(options = {}) {
    const inboxDir = join2(this.dataDir, "spool", "inbox");
    if (!existsSync2(inboxDir))
      return { scanned: 0, imported: 0, deduped: 0, queued: 0 };
    const limit = normalizePositiveInteger(options.limit, 100, "limit");
    const names = readdirSync(inboxDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, limit);
    const result = { scanned: names.length, imported: 0, deduped: 0, queued: 0 };
    for (const name of names) {
      const path = join2(inboxDir, name);
      let event;
      try {
        event = parseSpoolEnvelope(readFileSync(path, "utf8"));
      } catch (error) {
        if (isNodeError(error, "ENOENT"))
          continue;
        throw error;
      }
      if (spoolFileName(event) !== name)
        throw new Error("Durable event spool filename does not match its identity");
      const enqueued = this.enqueue(event);
      if (enqueued.deduped)
        result.deduped += 1;
      else
        result.imported += 1;
      result.queued += enqueued.queued;
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isNodeError(error, "ENOENT"))
          throw error;
      }
    }
    if (names.length > 0)
      syncDirectory(inboxDir);
    this.secureDatabaseFiles();
    return result;
  }
  retryDead(options = {}) {
    const limit = normalizePositiveInteger(options.limit, 100, "limit");
    return this.immediate(() => {
      const conditions = ["status = 'dead'"];
      const bindings = [];
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
      `).all(...bindings, limit);
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
  status() {
    const channels = this.count("SELECT COUNT(*) AS count FROM channels");
    const enabledChannels = this.count("SELECT COUNT(*) AS count FROM channels WHERE enabled = 1");
    const events = this.count("SELECT COUNT(*) AS count FROM events");
    const statusRows = this.db.query("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all();
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
        dead: statuses.dead ?? 0
      },
      safety: {
        statusOmitsEventPayloads: true,
        databasePersistsEventEnvelopes: true,
        includesResolvedSecrets: false,
        inlineWebhookSecretsAllowed: false
      }
    };
  }
  nextWakeAt() {
    const row = this.db.query(`
      SELECT MIN(
        CASE WHEN o.status = 'leased' THEN o.lease_expires_at ELSE o.available_at END
      ) AS next_at
      FROM outbox o
      JOIN channels c ON c.id = o.channel_id AND c.enabled = 1
      WHERE o.status IN ('pending', 'leased')
    `).get();
    return row?.next_at === null || row?.next_at === undefined ? undefined : Number(row.next_at);
  }
  claim(options) {
    return this.immediate(() => {
      const nowMs = this.now().getTime();
      const rows = this.db.query(`
        SELECT o.id, o.event_json, c.config_json AS channel_json,
               o.attempt_count, o.attempts_json
        FROM outbox o
        JOIN channels c ON c.id = o.channel_id AND c.enabled = 1
        WHERE (o.status = 'pending' AND o.available_at <= ?)
           OR (o.status = 'leased' AND o.lease_expires_at <= ?)
        ORDER BY o.available_at, o.created_at, o.id
        LIMIT ?
      `).all(nowMs, nowMs, options.limit);
      const jobs = [];
      for (const row of rows) {
        const nextAttempt = Number(row.attempt_count) + 1;
        const channel = parseJson(row.channel_json);
        const transportTimeoutMs = channel.webhook?.timeoutMs ?? channel.command?.timeoutMs ?? 15000;
        const leaseMs = Math.max(options.leaseMs, transportTimeoutMs + 5000);
        const update = this.db.query(`
          UPDATE outbox
          SET status = 'leased', attempt_count = ?, lease_owner = ?,
              lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND ((status = 'pending' AND available_at <= ?)
              OR (status = 'leased' AND lease_expires_at <= ?))
        `).run(nextAttempt, options.workerId, nowMs + leaseMs, this.now().toISOString(), row.id, nowMs, nowMs);
        if (Number(update.changes) !== 1)
          continue;
        jobs.push({
          id: row.id,
          event: parseJson(row.event_json),
          channel,
          attempt: nextAttempt,
          workerId: options.workerId
        });
      }
      return jobs;
    });
  }
  settle(job, attempt) {
    return this.immediate(() => {
      const row = this.db.query(`
        SELECT attempts_json FROM outbox
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
      `).get(job.id, job.workerId);
      if (!row)
        throw new Error("Durable delivery lease was lost before settlement");
      const attempts = parseJson(row.attempts_json);
      attempts.push(attempt);
      if (attempt.status === "success") {
        const delivery2 = createDeliveryResult(job.event, job.channel, attempts);
        this.completeOutbox(job, "delivered", attempts, delivery2);
        return { status: "delivered", delivery: delivery2 };
      }
      const retry = normalizeRetryPolicy2(job.channel.retry);
      if (job.attempt < retry.maxAttempts) {
        const backoffMs = Math.round(retry.backoffMs * retry.multiplier ** (job.attempt - 1));
        attempt.nextBackoffMs = backoffMs;
        this.db.query(`
          UPDATE outbox
          SET status = 'pending', available_at = ?, attempts_json = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND lease_owner = ?
        `).run(this.now().getTime() + backoffMs, JSON.stringify(attempts), this.now().toISOString(), job.id, job.workerId);
        return { status: "retry" };
      }
      const delivery = createDeliveryResult(job.event, job.channel, attempts);
      this.completeOutbox(job, "dead", attempts, delivery);
      return { status: "dead", delivery };
    });
  }
  completeOutbox(job, status, attempts, delivery) {
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
  findEvent(id, dedupeKey) {
    if (dedupeKey === undefined) {
      return this.db.query("SELECT envelope_json FROM events WHERE id = ? LIMIT 1").get(id);
    }
    return this.db.query(`
      SELECT envelope_json FROM events
      WHERE id = ? OR dedupe_key = ?
      LIMIT 1
    `).get(id, dedupeKey);
  }
  queueMatchingChannels(event) {
    const channels = this.db.query("SELECT config_json FROM channels WHERE enabled = 1 ORDER BY id").all();
    let queued = 0;
    for (const row of channels) {
      const channel = parseJson(row.config_json);
      if (!channelMatchesEvent(channel, event))
        continue;
      const timestamp = this.now().toISOString();
      const inserted = this.db.query(`
        INSERT OR IGNORE INTO outbox (
          id, event_id, channel_id, event_json, channel_json, status,
          attempt_count, available_at, attempts_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, '[]', ?, ?)
      `).run(randomUUID3(), event.id, channel.id, JSON.stringify(event), JSON.stringify(channel), this.now().getTime(), timestamp, timestamp);
      queued += Number(inserted.changes);
    }
    return queued;
  }
  count(sql) {
    const row = this.db.query(sql).get();
    return Number(row?.count ?? 0);
  }
  immediate(operation) {
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
  ensureSchema() {
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

      PRAGMA user_version = ${DURABLE_SCHEMA_VERSION};
    `);
  }
  secureDatabaseFiles() {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync2(path))
        continue;
      chmodSync(path, 384);
    }
  }
}
function normalizePositiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error(`${name} must be a positive integer`);
  return resolved;
}
function normalizeRetryPolicy2(policy) {
  return {
    maxAttempts: Math.max(1, Math.floor(policy?.maxAttempts ?? 1)),
    backoffMs: Math.max(0, Math.floor(policy?.backoffMs ?? 250)),
    multiplier: Math.max(1, policy?.multiplier ?? 2)
  };
}
function parseJson(value) {
  return JSON.parse(value);
}
function validateDurableWebhookConfig(webhook) {
  let url;
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
    if (/authorization|cookie|api[-_]?key|token|secret|credential/i.test(name)) {
      throw new Error("Durable webhook credential headers are not persisted; use webhook.secretRef");
    }
  }
}
function sanitizeDurableAttempt(attempt) {
  const { responseBody: _responseBody, stdout: _stdout, stderr: _stderr, ...metadata } = attempt;
  if (metadata.status === "failed") {
    metadata.error = metadata.responseStatus === undefined ? "Webhook delivery failed" : `Webhook returned HTTP ${metadata.responseStatus}`;
  }
  return metadata;
}
function parseSpoolEnvelope(raw) {
  const value = parseJson(raw);
  if (!value || typeof value !== "object")
    throw new Error("Invalid durable event spool record");
  for (const field of ["id", "source", "type", "time", "schemaVersion"]) {
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
  return value;
}
function syncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function isNodeError(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
function spoolFileName(event) {
  const identity = event.dedupeKey ?? event.id;
  return `${createHash("sha256").update(identity, "utf8").digest("hex")}.json`;
}

// src/durable-worker.ts
import { chmodSync as chmodSync2, mkdirSync as mkdirSync2, watch } from "fs";
import { randomUUID as randomUUID5 } from "crypto";
import { join as join4 } from "path";

// src/durable-spool.ts
import { createHash as createHash2, randomUUID as randomUUID4 } from "crypto";
import {
  chmod as chmod2,
  link,
  mkdir as mkdir2,
  open,
  readdir,
  readFile as readFile2,
  stat,
  unlink
} from "fs/promises";
import { join as join3 } from "path";

class DurableEventSpool {
  dataDir;
  inboxDir;
  constructor(options) {
    if (!options.dataDir)
      throw new Error("DurableEventSpool requires dataDir");
    this.dataDir = options.dataDir;
    this.inboxDir = join3(options.dataDir, "spool", "inbox");
  }
  async enqueue(input) {
    const event = createSpoolEvent(input);
    await this.ensureInbox();
    const finalPath = this.pathFor(event);
    const tempPath = join3(this.inboxDir, `.tmp-${process.pid}-${randomUUID4()}`);
    const handle = await open(tempPath, "wx", 384);
    try {
      await handle.writeFile(`${JSON.stringify(event)}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    let stored = false;
    try {
      await link(tempPath, finalPath);
      stored = true;
    } catch (error) {
      if (!isNodeError2(error, "EEXIST")) {
        await unlink(tempPath).catch(() => {
          return;
        });
        throw error;
      }
      await this.assertSameIdentity(finalPath, event);
    }
    await unlink(tempPath);
    await this.syncInbox();
    return { event, stored, deduped: !stored };
  }
  async recover(options = {}) {
    await this.ensureInbox();
    const olderThanMs = Math.max(0, options.olderThanMs ?? 60000);
    const threshold = Date.now() - olderThanMs;
    const result = { recovered: 0, deduped: 0, cleaned: 0 };
    const names = (await readdir(this.inboxDir)).filter((name) => name.startsWith(".tmp-")).sort();
    for (const name of names) {
      const tempPath = join3(this.inboxDir, name);
      const details = await stat(tempPath).catch(() => {
        return;
      });
      if (!details || details.mtimeMs > threshold)
        continue;
      let event;
      try {
        event = parseEnvelope(await readFile2(tempPath, "utf8"));
      } catch {
        await unlink(tempPath).catch(() => {
          return;
        });
        result.cleaned += 1;
        continue;
      }
      const finalPath = this.pathFor(event);
      try {
        await link(tempPath, finalPath);
        result.recovered += 1;
      } catch (error) {
        if (!isNodeError2(error, "EEXIST"))
          throw error;
        await this.assertSameIdentity(finalPath, event);
        result.deduped += 1;
      }
      await unlink(tempPath).catch(() => {
        return;
      });
    }
    if (result.recovered || result.deduped || result.cleaned)
      await this.syncInbox();
    return result;
  }
  async close() {}
  pathFor(event) {
    const identity = event.dedupeKey ?? event.id;
    const digest = createHash2("sha256").update(identity, "utf8").digest("hex");
    return join3(this.inboxDir, `${digest}.json`);
  }
  async assertSameIdentity(path, event) {
    const existing = parseEnvelope(await readFile2(path, "utf8"));
    const matches = existing.id === event.id || event.dedupeKey !== undefined && existing.dedupeKey === event.dedupeKey;
    if (!matches)
      throw new Error("Durable spool identity collision");
  }
  async ensureInbox() {
    const spoolDir = join3(this.dataDir, "spool");
    await mkdir2(this.inboxDir, { recursive: true, mode: 448 });
    await chmod2(this.dataDir, 448);
    await chmod2(spoolDir, 448);
    await chmod2(this.inboxDir, 448);
    await this.syncDirectory(this.dataDir);
    await this.syncDirectory(spoolDir);
  }
  async syncInbox() {
    await this.syncDirectory(this.inboxDir);
  }
  async syncDirectory(path) {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
function createSpoolEvent(input) {
  return {
    id: input.id ?? randomUUID4(),
    source: input.source,
    type: input.type,
    time: input.time instanceof Date ? input.time.toISOString() : input.time ?? new Date().toISOString(),
    subject: input.subject,
    severity: input.severity ?? "info",
    data: input.data ?? {},
    message: input.message,
    dedupeKey: input.dedupeKey,
    schemaVersion: input.schemaVersion ?? "1.0",
    metadata: input.metadata ?? {}
  };
}
function parseEnvelope(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("Invalid durable event spool record");
  for (const field of ["id", "source", "type", "time", "schemaVersion"]) {
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
  return value;
}
function isNodeError2(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

// src/durable-worker.ts
async function runDurableWorker(options) {
  const workerId = options.workerId ?? randomUUID5();
  const limit = positiveInteger(options.limit, 100, "limit");
  const leaseMs = positiveInteger(options.leaseMs, 60000, "leaseMs");
  const debounceMs = nonNegativeInteger(options.debounceMs, 50, "debounceMs");
  const reconcileMs = positiveInteger(options.reconcileMs, 30000, "reconcileMs");
  const watchRestartMs = positiveInteger(options.watchRestartMs, 1000, "watchRestartMs");
  const spool = new DurableEventSpool({ dataDir: options.broker.dataDir });
  const inboxDir = spool.inboxDir;
  mkdirSync2(inboxDir, { recursive: true, mode: 448 });
  chmodSync2(join4(options.broker.dataDir, "spool"), 448);
  chmodSync2(inboxDir, 448);
  const totals = {
    workerId,
    cycles: 0,
    imported: 0,
    deduped: 0,
    delivered: 0,
    retried: 0,
    dead: 0
  };
  return new Promise((resolve, reject) => {
    let watcher;
    let debounceTimer;
    let retryTimer;
    let reconcileTimer;
    let restartTimer;
    let running = false;
    let rerun = false;
    let stopped = false;
    const clearRetryTimer = () => {
      if (retryTimer)
        clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const stop = () => {
      if (stopped)
        return;
      stopped = true;
      watcher?.close();
      if (debounceTimer)
        clearTimeout(debounceTimer);
      clearRetryTimer();
      if (reconcileTimer)
        clearInterval(reconcileTimer);
      if (restartTimer)
        clearTimeout(restartTimer);
      options.signal.removeEventListener("abort", stop);
      if (!running)
        resolve(totals);
    };
    const scheduleRetryWake = () => {
      clearRetryTimer();
      if (stopped)
        return;
      const nextWakeAt = options.broker.nextWakeAt();
      if (nextWakeAt === undefined)
        return;
      const delay = Math.max(0, nextWakeAt - Date.now());
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        runCycle();
      }, delay);
    };
    const runCycle = async () => {
      if (stopped)
        return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      clearRetryTimer();
      try {
        await spool.recover();
        const imported = options.broker.importSpool({ limit });
        const drained = await options.broker.drain({ workerId, limit, leaseMs });
        const cycle = { imported, drained };
        totals.cycles += 1;
        totals.imported += imported.imported;
        totals.deduped += imported.deduped;
        totals.delivered += drained.delivered;
        totals.retried += drained.retried;
        totals.dead += drained.dead;
        await options.onCycle?.(cycle);
        if (imported.scanned >= limit || drained.claimed >= limit)
          rerun = true;
      } catch (error) {
        reject(error);
        stop();
        return;
      } finally {
        running = false;
      }
      if (stopped) {
        resolve(totals);
      } else if (rerun) {
        rerun = false;
        queueMicrotask(() => {
          runCycle();
        });
      } else {
        scheduleRetryWake();
      }
    };
    const scheduleDebouncedCycle = () => {
      if (stopped)
        return;
      if (debounceTimer)
        clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        runCycle();
      }, debounceMs);
    };
    const startWatcher = () => {
      if (stopped)
        return;
      watcher?.close();
      try {
        watcher = watch(inboxDir, (_eventType, filename) => {
          if (!filename || filename.toString().endsWith(".json"))
            scheduleDebouncedCycle();
        });
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
          scheduleDebouncedCycle();
          if (!stopped)
            restartTimer = setTimeout(startWatcher, watchRestartMs);
        });
      } catch {
        scheduleDebouncedCycle();
        if (!stopped)
          restartTimer = setTimeout(startWatcher, watchRestartMs);
      }
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) {
      stop();
      return;
    }
    startWatcher();
    reconcileTimer = setInterval(() => {
      runCycle();
    }, reconcileMs);
    runCycle();
  });
}
function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error(`${name} must be a positive integer`);
  return resolved;
}
function nonNegativeInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return resolved;
}

// src/filter-options.ts
function parseFieldMatchers(values, label, typed = false) {
  if (!values?.length)
    return;
  const result = {};
  for (const value of values) {
    const parsed = parseMatcherExpression(value, label);
    const path = parsed.path;
    if (path in result)
      throw new Error(`Duplicate ${label} filter path: ${path}`);
    const matcherValue = typed ? parseTypedMatcherValue(parsed.rawValue, label) : parsed.rawValue;
    result[path] = parsed.negated ? { not: matcherValue } : matcherValue;
  }
  return result;
}
function parseFilterOptions(options) {
  const filter2 = {};
  if (options.source)
    filter2.source = options.source;
  if (options.type)
    filter2.type = options.type;
  if (options.subject)
    filter2.subject = options.subject;
  if (options.severity)
    filter2.severity = options.severity;
  const data = mergeMatchers(parseFieldMatchers(options.data, "data"), parseFieldMatchers(options.dataJson, "data-json", true));
  const metadata = mergeMatchers(parseFieldMatchers(options.metadata, "metadata"), parseFieldMatchers(options.metadataJson, "metadata-json", true));
  if (Object.keys(data).length > 0)
    filter2.data = data;
  if (Object.keys(metadata).length > 0)
    filter2.metadata = metadata;
  return Object.keys(filter2).length > 0 ? [filter2] : undefined;
}
function mergeMatchers(...records) {
  const result = {};
  for (const record of records) {
    if (!record)
      continue;
    for (const [path, value] of Object.entries(record)) {
      if (path in result)
        throw new Error(`Duplicate filter path: ${path}`);
      result[path] = value;
    }
  }
  return result;
}
function parseTypedMatcherValue(value, label) {
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean" || Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }
  throw new Error(`${label} filter JSON values must be string, string[], number, boolean, or null`);
}
function parseMatcherExpression(value, label) {
  const negativeSeparator = value.indexOf("!=");
  if (negativeSeparator > 0) {
    return {
      path: value.slice(0, negativeSeparator),
      rawValue: value.slice(negativeSeparator + 2),
      negated: true
    };
  }
  const separator = value.indexOf("=");
  if (separator <= 0)
    throw new Error(`Invalid ${label} filter, expected path=value or path!=value: ${value}`);
  return {
    path: value.slice(0, separator),
    rawValue: value.slice(separator + 1),
    negated: false
  };
}

// src/cli/index.ts
function version() {
  try {
    const packagePath = join5(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync2(packagePath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function parseGlobalArgs(argv) {
  const rest = [];
  let json = false;
  let dir;
  for (let index = 0;index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      rest.push(...argv.slice(index));
      break;
    }
    if (arg === "--json" || arg === "-j") {
      json = true;
    } else if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg === "--dir") {
      dir = argv[++index];
    } else {
      rest.push(...argv.slice(index));
      break;
    }
  }
  return { json, dir, rest };
}
function takeOption(args, name) {
  const equalsPrefix = `${name}=`;
  const equalsIndex = args.findIndex((arg) => arg.startsWith(equalsPrefix));
  if (equalsIndex !== -1) {
    const value2 = args[equalsIndex]?.slice(equalsPrefix.length);
    args.splice(equalsIndex, 1);
    return value2;
  }
  const index = args.indexOf(name);
  if (index === -1)
    return;
  const value = args[index + 1];
  if (value === undefined)
    throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}
function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1)
    return false;
  args.splice(index, 1);
  return true;
}
function takeMany(args, name) {
  const values = [];
  while (args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`))) {
    const value = takeOption(args, name);
    if (value !== undefined)
      values.push(value);
  }
  return values;
}
function parseJsonOption(value, fallback) {
  if (!value)
    return fallback;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed;
}
function parseFilter(args) {
  return parseFilterOptions({
    type: takeOption(args, "--type") ?? takeOption(args, "--event-type"),
    source: takeOption(args, "--source"),
    subject: takeOption(args, "--subject"),
    severity: takeOption(args, "--severity"),
    data: takeMany(args, "--data"),
    metadata: takeMany(args, "--metadata"),
    dataJson: takeMany(args, "--data-json"),
    metadataJson: takeMany(args, "--metadata-json")
  });
}
function parseHeaders(values) {
  if (values.length === 0)
    return;
  const headers = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1)
      throw new Error(`Invalid header, expected name=value: ${value}`);
    headers[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return headers;
}
function output(parsed, value, human) {
  if (parsed.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  human();
}
function commandName(options) {
  return options.programName ?? "events";
}
function printHelp(options = {}) {
  const name = commandName(options);
  console.log(`${name} ${version()}

Usage:
  ${name} [--dir <path>] [--json] channels add <url|command> [options]
  ${name} [--dir <path>] [--json] channels list
  ${name} [--dir <path>] [--json] channels remove <id>
  ${name} [--dir <path>] [--json] channels test <id>
  ${name} [--dir <path>] [--json] channels match <id>
  ${name} [--dir <path>] [--json] channels status
  ${name} [--dir <path>] [--json] status
  ${name} [--dir <path>] [--json] events emit <type>${options.source ? "" : " --source <source>"} [options]
  ${name} [--dir <path>] [--json] events list [--limit <n>]
  ${name} [--dir <path>] [--json] events replay [--id <event-id>] [--cursor <cursor>] [--limit <n>] [--dry-run]
  ${name} [--dir <path>] [--json] durable channel <url> [options]
  ${name} [--dir <path>] [--json] durable enqueue <type> --source <source> [options]
  ${name} [--dir <path>] [--json] durable import [--limit <n>]
  ${name} [--dir <path>] [--json] durable drain [--limit <n>] [--lease-ms <ms>]
  ${name} [--dir <path>] [--json] durable work [--limit <n>] [--lease-ms <ms>] [--reconcile-ms <ms>]
  ${name} [--dir <path>] [--json] durable retry-dead [--event-id <id>] [--channel-id <id>] [--limit <n>]
  ${name} [--dir <path>] [--json] durable status

Global options (must precede the command group):
  --dir <path>              Data directory
  -j, --json               Print JSON output
  -h, --help               Show help
  -v, --version            Show version

Environment:
  HASNA_EVENTS_DIR          Primary data-directory override
  HASNA_EVENTS_HOME         Legacy data-directory fallback
  Default directory         ${getEventsDataDir()}`);
}
function printChannelsHelp(options = {}) {
  const name = commandName(options);
  console.log(`${name} channels

Usage:
  ${name} [--dir <path>] [--json] channels add <url|command> [options]
  ${name} [--dir <path>] [--json] channels list
  ${name} [--dir <path>] [--json] channels remove <id>
  ${name} [--dir <path>] [--json] channels test <id>
  ${name} [--dir <path>] [--json] channels match <id>
  ${name} [--dir <path>] [--json] channels status

Commands:
  add                       Add or replace a channel
  list                      List configured channels
  remove                    Remove a channel
  test                      Send a sample event to one channel
  match                     Preview a sample event without delivery
  status                    Show channel storage status

Run '${name} channels add --help' for add options.

Test and match options:
  --source <source>         Event source (default: ${options.source ?? "hasna.events"})
  --type <type>             Event type (default: events.test)
  --subject <subject>       Event subject (default: channel id)
  --message <message>       Event message
  --data <json>             Event data object
  --metadata <json>         Event metadata object
  --honor-filters           Test only: skip delivery on a filter mismatch`);
}
function printChannelAddHelp(options = {}) {
  const name = commandName(options);
  console.log(`${name} channels add

Usage:
  ${name} [--dir <path>] [--json] channels add <url|command> [options]
  ${name} [--dir <path>] [--json] channels add <command> --transport command [options] -- [command-args...]

Options:
  --id <id>                 Channel id (default: generated UUID)
  --name <name>             Display name
  --transport <kind>        webhook or command (default: webhook)
  --type <pattern>          Event type filter, supports wildcards
  --event-type <pattern>    Alias for --type
  --source <source>         Event source filter
  --subject <subject>       Event subject filter
  --severity <severity>     Event severity filter
  --data <path=value>       String data filter; repeatable; != negates
  --metadata <path=value>   String metadata filter; repeatable; != negates
  --data-json <path=json>   Typed JSON data filter; repeatable; != negates
  --metadata-json <path=json> Typed JSON metadata filter; repeatable; != negates
  --secret <secret>         Webhook signing secret
  --header <name=value>     Webhook header, repeatable
  --arg <arg>               Command argument, repeatable; values may begin with dashes
  --timeout-ms <ms>         Transport timeout (default: 15000)
  --retry-attempts <n>      Maximum delivery attempts (default: 1)
  --retry-backoff-ms <ms>   Initial retry backoff (default: 250)
  --redact <path>           Redaction path, repeatable
  --disabled                Create channel disabled

Examples:
  ${name} channels add https://example.com/channels/hasna --id ops --retry-attempts 3 --retry-backoff-ms 500
  ${name} channels add bun --id command-hook --transport command --arg run --arg ./handler.ts --arg --json
  ${name} channels add bun --id command-hook --transport command --arg=--json
  ${name} channels add bun --id command-hook --transport command -- run ./handler.ts --json`);
}
function printEventsHelp(options = {}) {
  const name = commandName(options);
  console.log(`${name} events

Usage:
  ${name} [--dir <path>] [--json] events emit <type>${options.source ? "" : " --source <source>"} [options]
  ${name} [--dir <path>] [--json] events list [--limit <n>]
  ${name} [--dir <path>] [--json] events replay [--id <event-id>] [--cursor <cursor>] [--limit <n>] [--dry-run]

Emit options:
  --source <source>         Event source${options.source ? ` (default: ${options.source})` : ""}
  --subject <subject>       Event subject
  --severity <severity>     debug|info|notice|warning|error|critical (default: info)
  --message <message>       Human-readable event message
  --dedupe-key <key>        Deduplicate repeated events
  --data <json>             JSON object payload
  --metadata <json>         JSON object metadata
  --no-deliver              Record without delivering channels

List options:
  --source <source>         Filter by exact source
  --type <type>             Filter by exact type
  --limit <n>               Most recent events; 0 or omitted lists all

Replay options:
  --id <event-id>           Filter by exact event id
  --source <source>         Filter by exact source
  --type <type>             Filter by exact type
  --cursor <cursor>         Opaque cursor returned by a previous replay page
  --limit <n>               Maximum events to replay
  --dry-run                 Preview replay matches without delivery`);
}
async function runEventsCli(argv = process.argv.slice(2), options = {}) {
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
  if (group === "durable") {
    if (!command || command === "--help" || command === "-h" || tail.includes("--help") || tail.includes("-h")) {
      printDurableHelp(options);
      return;
    }
    const broker = new DurableEventsBroker({ dataDir: parsed.dir ?? getEventsDataDir() });
    try {
      await handleDurable(broker, command, tail, parsed);
    } finally {
      broker.close();
    }
    return;
  }
  const store = new JsonEventsStore(parsed.dir);
  const client = new EventsClient({ store });
  if (group === "channels") {
    if (!command || command === "--help" || command === "-h") {
      printChannelsHelp(options);
      return;
    }
    if (command === "add" && (tail[0] === "--help" || tail[0] === "-h")) {
      printChannelAddHelp(options);
      return;
    }
    if (tail.includes("--help") || tail.includes("-h")) {
      printChannelsHelp(options);
      return;
    }
    await handleChannels(client, command, tail, parsed, options);
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
function printDurableHelp(options = {}) {
  const name = commandName(options);
  console.log(`${name} durable

Usage:
  ${name} [--dir <path>] [--json] durable channel <url> --id <id> --source <source> --type <type> --secret-ref <ref> [options]
  ${name} [--dir <path>] [--json] durable enqueue <type> --source <source> [options]
  ${name} [--dir <path>] [--json] durable import [--limit <n>]
  ${name} [--dir <path>] [--json] durable drain [--limit <n>] [--lease-ms <ms>]
  ${name} [--dir <path>] [--json] durable work [--limit <n>] [--lease-ms <ms>] [--reconcile-ms <ms>]
  ${name} [--dir <path>] [--json] durable retry-dead [--event-id <id>] [--channel-id <id>] [--limit <n>]
  ${name} [--dir <path>] [--json] durable status

Channel options:
  --id <id>                 Required stable channel id
  --source <source>         Required exact source filter
  --type <type>             Required exact event type filter
  --secret-ref <ref>        Runtime secret reference, e.g. env:HASNA_WEBHOOK_SECRET
  --timeout-ms <ms>         Webhook timeout (default: 15000)
  --retry-attempts <n>      Maximum durable attempts (default: 1)
  --retry-backoff-ms <ms>   Initial persisted backoff (default: 250)
  --disabled                Persist the route disabled

Enqueue options:
  --id <id>                 Stable event id
  --subject <subject>       Stable event subject
  --time <iso-time>         Event occurrence time
  --schema-version <value>  Envelope schema version
  --dedupe-key <key>        Stable business idempotency key
  --data <json>             Event data object
  --metadata <json>         Event metadata object`);
}
async function handleDurable(broker, command, tail, parsed) {
  if (command === "channel") {
    const args = [...tail];
    const target = args.shift();
    if (!target)
      throw new Error("durable channel requires a webhook URL");
    const id = takeOption(args, "--id");
    const source = takeOption(args, "--source");
    const type = takeOption(args, "--type");
    if (!id || !source || !type)
      throw new Error("durable channel requires --id, --source, and --type");
    if (source.includes("*") || type.includes("*"))
      throw new Error("durable channel source/type filters must be exact");
    const secretRef = takeOption(args, "--secret-ref");
    if (!secretRef)
      throw new Error("durable channel requires --secret-ref");
    const timeoutMs = numberOption(takeOption(args, "--timeout-ms"));
    const retryAttempts = numberOption(takeOption(args, "--retry-attempts"));
    const retryBackoffMs = numberOption(takeOption(args, "--retry-backoff-ms"));
    const channel = broker.addChannel({
      id,
      enabled: !takeFlag(args, "--disabled"),
      transport: "webhook",
      filters: [{ source, type }],
      webhook: { url: target, secretRef, timeoutMs },
      retry: retryAttempts || retryBackoffMs ? { maxAttempts: retryAttempts, backoffMs: retryBackoffMs } : undefined
    });
    output(parsed, sanitizeChannelForOutput(channel), () => console.log(`Added durable webhook channel ${channel.id}`));
    return;
  }
  if (command === "enqueue") {
    const args = [...tail];
    const type = args.shift();
    if (!type)
      throw new Error("durable enqueue requires an event type");
    const source = takeOption(args, "--source");
    if (!source)
      throw new Error("durable enqueue requires --source");
    const result = broker.enqueue({
      id: takeOption(args, "--id"),
      source,
      type,
      time: takeOption(args, "--time"),
      subject: takeOption(args, "--subject"),
      dedupeKey: takeOption(args, "--dedupe-key"),
      schemaVersion: takeOption(args, "--schema-version"),
      data: parseJsonOption(takeOption(args, "--data"), {}),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {})
    });
    output(parsed, result, () => console.log(`${result.deduped ? "Deduped" : "Enqueued"} ${result.event.id} to ${result.queued} channel(s)`));
    return;
  }
  if (command === "import") {
    const args = [...tail];
    const result = broker.importSpool({ limit: numberOption(takeOption(args, "--limit")) });
    output(parsed, result, () => console.log(`Imported ${result.imported}, deduped ${result.deduped}, queued ${result.queued}`));
    return;
  }
  if (command === "drain") {
    const args = [...tail];
    const limit = numberOption(takeOption(args, "--limit"));
    const imported = broker.importSpool({ limit });
    const drained = await broker.drain({
      limit,
      leaseMs: numberOption(takeOption(args, "--lease-ms")),
      workerId: takeOption(args, "--worker-id")
    });
    const result = { imported, drained };
    output(parsed, result, () => console.log(`Claimed ${drained.claimed}, delivered ${drained.delivered}, retried ${drained.retried}, dead ${drained.dead}`));
    return;
  }
  if (command === "work") {
    const args = [...tail];
    const controller = new AbortController;
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      const result = await runDurableWorker({
        broker,
        signal: controller.signal,
        limit: numberOption(takeOption(args, "--limit")),
        leaseMs: numberOption(takeOption(args, "--lease-ms")),
        workerId: takeOption(args, "--worker-id"),
        debounceMs: numberOption(takeOption(args, "--debounce-ms")),
        reconcileMs: numberOption(takeOption(args, "--reconcile-ms")),
        watchRestartMs: numberOption(takeOption(args, "--watch-restart-ms"))
      });
      output(parsed, result, () => console.log(`Worker stopped after ${result.cycles} cycle(s), delivered ${result.delivered}`));
    } finally {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
    return;
  }
  if (command === "status") {
    const result = broker.status();
    output(parsed, result, () => console.log(`events durable: ${result.counts.pending} pending, ${result.counts.leased} leased, ${result.counts.dead} dead`));
    return;
  }
  if (command === "retry-dead") {
    const args = [...tail];
    const result = broker.retryDead({
      eventId: takeOption(args, "--event-id"),
      channelId: takeOption(args, "--channel-id"),
      limit: numberOption(takeOption(args, "--limit"))
    });
    output(parsed, result, () => console.log(`Requeued ${result.requeued} dead delivery job(s)`));
    return;
  }
  throw new Error(`Unknown durable command: ${command}`);
}
async function handleChannels(client, command, tail, parsed, options) {
  if (command === "add") {
    const { args, delimiterArgs } = splitDelimiter(tail);
    const transport = takeOption(args, "--transport") ?? "webhook";
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
    if (!target)
      throw new Error("channels add requires a URL or command target");
    const now2 = new Date().toISOString();
    const channel = {
      id,
      name,
      enabled: !disabled,
      transport,
      filters,
      retry: retryAttempts || retryBackoffMs ? { maxAttempts: retryAttempts, backoffMs: retryBackoffMs } : undefined,
      redact: redactions.length > 0 ? { paths: redactions } : undefined,
      createdAt: now2,
      updatedAt: now2
    };
    if (transport === "webhook") {
      channel.webhook = { url: target, secret, headers: parseHeaders(headerValues), timeoutMs };
    } else if (transport === "command") {
      channel.command = { command: target, args: [...args.slice(1), ...commandArgs, ...delimiterArgs], timeoutMs };
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
        console.log(`${channel.id}	${channel.enabled ? "enabled" : "disabled"}	${channel.transport}	${target}`);
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
    if (!id)
      throw new Error("channels remove requires a channel id");
    const removed = await client.removeChannel(id);
    output(parsed, { removed }, () => console.log(removed ? `Removed ${id}` : `Channel not found: ${id}`));
    return;
  }
  if (command === "test") {
    const args = [...tail];
    const id = args.shift();
    if (!id)
      throw new Error("channels test requires a channel id");
    const honorFilters = takeFlag(args, "--honor-filters");
    const result = await client.testChannel(id, {
      source: takeOption(args, "--source") ?? options.source ?? "hasna.events",
      type: takeOption(args, "--type") ?? "events.test",
      subject: takeOption(args, "--subject") ?? id,
      message: takeOption(args, "--message") ?? "Hasna events test delivery",
      data: parseJsonOption(takeOption(args, "--data"), { test: true }),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {})
    }, { honorFilters });
    output(parsed, result, () => console.log(`${result.status}: ${result.channelId}`));
    return;
  }
  if (command === "match") {
    const args = [...tail];
    const id = args.shift();
    if (!id)
      throw new Error("channels match requires a channel id");
    const result = await client.matchChannel(id, {
      source: takeOption(args, "--source") ?? options.source ?? "hasna.events",
      type: takeOption(args, "--type") ?? "events.test",
      subject: takeOption(args, "--subject") ?? id,
      message: takeOption(args, "--message") ?? "Hasna events match preview",
      data: parseJsonOption(takeOption(args, "--data"), { test: true }),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {})
    });
    output(parsed, result, () => console.log(`${result.matched ? "matched" : "skipped"}: ${result.channelId}`));
    return;
  }
  throw new Error(`Unknown channels command: ${command ?? ""}`);
}
function splitDelimiter(values) {
  const delimiterIndex = values.indexOf("--");
  if (delimiterIndex === -1)
    return { args: [...values], delimiterArgs: [] };
  return {
    args: values.slice(0, delimiterIndex),
    delimiterArgs: values.slice(delimiterIndex + 1)
  };
}
async function handleEvents(client, command, tail, parsed, options) {
  if (command === "emit") {
    const args = [...tail];
    const type = args.shift();
    if (!type)
      throw new Error("events emit requires an event type");
    const source = takeOption(args, "--source") ?? options.source;
    if (!source)
      throw new Error("events emit requires --source");
    const noDeliver = takeFlag(args, "--no-deliver");
    const result = await client.emit({
      type,
      source,
      subject: takeOption(args, "--subject"),
      severity: severityOption(takeOption(args, "--severity")),
      message: takeOption(args, "--message"),
      dedupeKey: takeOption(args, "--dedupe-key"),
      data: parseJsonOption(takeOption(args, "--data"), {}),
      metadata: parseJsonOption(takeOption(args, "--metadata"), {})
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
    if (type)
      events = events.filter((event) => event.type === type);
    if (source)
      events = events.filter((event) => event.source === source);
    if (limit)
      events = events.slice(-limit);
    output(parsed, events, () => {
      if (events.length === 0) {
        console.log("No events recorded.");
        return;
      }
      for (const event of events) {
        console.log(`${event.time}	${event.id}	${event.source}	${event.type}	${event.severity}`);
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
      cursor: takeOption(args, "--cursor"),
      limit: numberOption(takeOption(args, "--limit")),
      dryRun: takeFlag(args, "--dry-run")
    });
    output(parsed, result, () => console.log(replaySummary(result.events.length, result.deliveries.length, result.nextCursor)));
    return;
  }
  throw new Error(`Unknown events command: ${command ?? ""}`);
}
function numberOption(value) {
  if (value === undefined)
    return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Expected a number, got ${value}`);
  return parsed;
}
function severityOption(value) {
  if (!value)
    return;
  const allowed = new Set(["debug", "info", "notice", "warning", "error", "critical"]);
  if (!allowed.has(value))
    throw new Error(`Invalid severity: ${value}`);
  return value;
}
function replaySummary(events, deliveries, nextCursor) {
  const suffix = nextCursor ? `, next cursor: ${nextCursor}` : "";
  return `Replayed ${events} event(s), ${deliveries} delivery result(s)${suffix}`;
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
export {
  runEventsCli
};
