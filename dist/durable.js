// @bun
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
function verifyPayloadSignature(secret, timestamp, body, signature) {
  const expected = signPayload(secret, timestamp, body);
  const actual = signature.trim();
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length)
    return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
function isTimestampWithinTolerance(timestamp, toleranceMs, now = Date.now()) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed))
    return false;
  const reference = now instanceof Date ? now.getTime() : now;
  return Math.abs(reference - parsed) <= toleranceMs;
}
function verifyWebhookSignature(secret, timestamp, body, signature, options = {}) {
  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  if (!isTimestampWithinTolerance(timestamp, toleranceMs, options.now)) {
    return false;
  }
  return verifyPayloadSignature(secret, timestamp, body, signature);
}

// src/transports.ts
import { randomUUID } from "crypto";
import { spawn } from "child_process";
function now() {
  return new Date().toISOString();
}
function truncate(value, max = 4096) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
function buildWebhookRequest(event, channel, options = {}) {
  if (!channel.webhook)
    throw new Error(`Channel ${channel.id} has no webhook config`);
  for (const name of Object.keys(channel.webhook.headers ?? {})) {
    if (/^x-hasna-/i.test(name)) {
      throw new Error(`Webhook header ${name} is reserved for signed delivery metadata`);
    }
  }
  const body = JSON.stringify(event);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "@hasna/events",
    "X-Hasna-Event-Id": event.id,
    "X-Hasna-Event-Type": event.type,
    ...channel.webhook.headers,
    "X-Hasna-Timestamp": timestamp
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
var DISTRIBUTION_EVENT_TYPES = {
  releasePublished: "release.published",
  rolloutStarted: "release.rollout.started",
  rolloutCompleted: "release.rollout.completed",
  rolloutFailed: "release.rollout.failed",
  appInstalled: "app.installed",
  announcementSent: "announcement.sent",
  feedbackCreated: "feedback.created",
  feedbackTriaged: "feedback.triaged"
};
var DISTRIBUTION_EVENT_CONTRACT_SCHEMAS = {
  "release.published": "hasna.release.v1",
  "release.rollout.started": "hasna.rollout_record.v1",
  "release.rollout.completed": "hasna.rollout_record.v1",
  "release.rollout.failed": "hasna.rollout_record.v1",
  "app.installed": "hasna.rollout_record.v1",
  "announcement.sent": "hasna.announcement.v1",
  "feedback.created": "hasna.feedback.v1",
  "feedback.triaged": "hasna.feedback.v1"
};
var PUBLISH_PATHS = ["skill", "ci", "backfilled"];
var ROLLOUT_ACTIONS = ["install", "update", "rollback", "freeze-blocked"];
function requireString(data, key, issues) {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: key, message: "must be a non-empty string" });
  }
}
function optionalString(data, key, issues) {
  const value = data[key];
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    issues.push({ path: key, message: "must be a non-empty string when present" });
  }
}
function optionalEnum(data, key, allowed, issues) {
  const value = data[key];
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    issues.push({ path: key, message: `must be one of: ${allowed.join(", ")}` });
  }
}
function optionalStringArray(data, key, issues) {
  const value = data[key];
  if (value === undefined)
    return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    issues.push({ path: key, message: "must be an array of non-empty strings when present" });
  }
}
function toResult(issues) {
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
var validateReleasePublishedData = (data) => {
  const issues = [];
  requireString(data, "appId", issues);
  requireString(data, "package", issues);
  requireString(data, "version", issues);
  optionalString(data, "gitSha", issues);
  optionalString(data, "publishedAt", issues);
  optionalEnum(data, "publishPath", PUBLISH_PATHS, issues);
  return toResult(issues);
};
var validateRolloutData = (data, event) => {
  const issues = [];
  requireString(data, "appId", issues);
  requireString(data, "package", issues);
  requireString(data, "version", issues);
  requireString(data, "machine", issues);
  optionalEnum(data, "action", ROLLOUT_ACTIONS, issues);
  if (event.type === "release.rollout.completed" || event.type === "release.rollout.failed") {
    requireString(data, "result", issues);
  }
  return toResult(issues);
};
var validateAppInstalledData = (data) => {
  const issues = [];
  requireString(data, "appId", issues);
  requireString(data, "package", issues);
  requireString(data, "version", issues);
  requireString(data, "machine", issues);
  return toResult(issues);
};
var validateAnnouncementSentData = (data) => {
  const issues = [];
  requireString(data, "campaignId", issues);
  optionalString(data, "appId", issues);
  optionalString(data, "audienceId", issues);
  optionalString(data, "releaseId", issues);
  optionalStringArray(data, "channels", issues);
  return toResult(issues);
};
var validateFeedbackCreatedData = (data) => {
  const issues = [];
  requireString(data, "feedbackId", issues);
  optionalString(data, "appId", issues);
  optionalString(data, "source", issues);
  optionalString(data, "summary", issues);
  return toResult(issues);
};
var validateFeedbackTriagedData = (data) => {
  const issues = [];
  requireString(data, "feedbackId", issues);
  requireString(data, "disposition", issues);
  optionalString(data, "appId", issues);
  optionalString(data, "triagedBy", issues);
  return toResult(issues);
};
function createDistributionEventDefinitions() {
  const bind = (type, validate, description) => ({
    type,
    contractSchemaId: DISTRIBUTION_EVENT_CONTRACT_SCHEMAS[type],
    description,
    validate
  });
  return [
    bind("release.published", validateReleasePublishedData, "A package version was published"),
    bind("release.rollout.started", validateRolloutData, "A rollout of a release to a machine started"),
    bind("release.rollout.completed", validateRolloutData, "A rollout of a release to a machine completed"),
    bind("release.rollout.failed", validateRolloutData, "A rollout of a release to a machine failed"),
    bind("app.installed", validateAppInstalledData, "An app was installed on a machine"),
    bind("announcement.sent", validateAnnouncementSentData, "An announcement campaign was sent"),
    bind("feedback.created", validateFeedbackCreatedData, "User or agent feedback was captured"),
    bind("feedback.triaged", validateFeedbackTriagedData, "Captured feedback was triaged")
  ];
}
function registerDistributionEventTypes(catalog = defaultEventTypeCatalog) {
  for (const definition of createDistributionEventDefinitions()) {
    catalog.register(definition);
  }
  return catalog;
}
// src/app-event.ts
var APP_EVENT_V1_SCHEMA_VERSION = "hasna.app_event.v1";
var APP_EVENT_V1_METADATA_KEY = "app_event";
var APP_EVENT_V1_MAX_SUMMARY_LENGTH = 512;
var APP_EVENT_V1_MAX_DATA_BYTES = 32 * 1024;
var APP_EVENT_V1_MAX_REFS = 32;
var APP_EVENT_V1_MAX_TARGETS = 16;

class AppEventValidationError extends Error {
  issues;
  constructor(issues) {
    super(`Invalid ${APP_EVENT_V1_SCHEMA_VERSION}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "AppEventValidationError";
    this.issues = issues;
  }
}

class AppEventReplaySafetyError extends Error {
  eventId;
  constructor(eventId) {
    super(`App event ${eventId} is not marked replay-safe`);
    this.name = "AppEventReplaySafetyError";
    this.eventId = eventId;
  }
}
var SEVERITIES = ["debug", "info", "notice", "warning", "error", "critical"];
var ACTOR_KINDS = ["agent", "human", "service", "model", "workflow", "system"];
var SENSITIVITIES = ["public", "internal", "confidential", "restricted"];
var REDACTION_STATES = ["none", "partial", "full"];
var DELIVERY_INTENTS = ["notification", "state_sync", "audit", "command"];
var DELIVERY_MODES = ["at_most_once", "at_least_once"];
function validateAppEventV1(value) {
  const issues = [];
  if (!isRecord(value))
    return { ok: false, issues: [{ path: "<root>", message: "must be an object" }] };
  rejectUnknownKeys(value, [
    "event_id",
    "event_type",
    "schema_version",
    "source",
    "occurred_at",
    "severity",
    "idempotency",
    "correlation",
    "subject",
    "actor",
    "project_mappings",
    "summary",
    "data",
    "resource_refs",
    "evidence_refs",
    "sensitivity",
    "redaction",
    "delivery"
  ], "", issues);
  requireString2(value, "event_id", "event_id", issues, 200);
  requireString2(value, "event_type", "event_type", issues, 200);
  if (value.schema_version !== APP_EVENT_V1_SCHEMA_VERSION) {
    issues.push({ path: "schema_version", message: `must equal ${APP_EVENT_V1_SCHEMA_VERSION}` });
  }
  requireTimestamp(value, "occurred_at", issues);
  requireEnum(value, "severity", SEVERITIES, "severity", issues);
  requireString2(value, "summary", "summary", issues, APP_EVENT_V1_MAX_SUMMARY_LENGTH);
  const source = requireRecord(value, "source", issues);
  if (source) {
    rejectUnknownKeys(source, ["app", "version", "machine"], "source", issues);
    requireString2(source, "app", "source.app", issues, 200);
    requireString2(source, "version", "source.version", issues, 100);
    requireString2(source, "machine", "source.machine", issues, 200);
  }
  const idempotency = requireRecord(value, "idempotency", issues);
  if (idempotency) {
    rejectUnknownKeys(idempotency, ["dedupe_key", "replay_safe", "replay_of_event_id"], "idempotency", issues);
    requireString2(idempotency, "dedupe_key", "idempotency.dedupe_key", issues, 512);
    requireBoolean(idempotency, "replay_safe", "idempotency.replay_safe", issues);
    optionalString2(idempotency, "replay_of_event_id", "idempotency.replay_of_event_id", issues, 200);
    if (idempotency.replay_of_event_id === value.event_id) {
      issues.push({ path: "idempotency.replay_of_event_id", message: "must not reference the event itself" });
    }
  }
  const correlation = requireRecord(value, "correlation", issues);
  if (correlation) {
    rejectUnknownKeys(correlation, ["correlation_id", "causation_id", "trace_id"], "correlation", issues);
    requireString2(correlation, "correlation_id", "correlation.correlation_id", issues, 200);
    optionalString2(correlation, "causation_id", "correlation.causation_id", issues, 200);
    optionalString2(correlation, "trace_id", "correlation.trace_id", issues, 200);
  }
  validateSubject(value, issues);
  validateActor(value, issues);
  validateProjectMappings(value, issues);
  validateData(value.data, issues);
  validateResourceRefs(value.resource_refs, issues);
  validateEvidenceRefs(value.evidence_refs, issues);
  validateSensitivity(value, issues);
  validateRedaction(value, issues);
  validateDelivery(value, issues);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
function assertAppEventV1(value) {
  const result = validateAppEventV1(value);
  if (!result.ok)
    throw new AppEventValidationError(result.issues);
}
function assertAppEventV1ReplaySafe(event) {
  assertAppEventV1(event);
  if (!event.idempotency.replay_safe)
    throw new AppEventReplaySafetyError(event.event_id);
}
function appEventV1ReplayIdentity(event) {
  assertAppEventV1ReplaySafe(event);
  return { eventId: event.event_id, dedupeKey: event.idempotency.dedupe_key };
}
function appEventV1ToEventInput(event) {
  assertAppEventV1(event);
  const metadata = {
    profile: APP_EVENT_V1_SCHEMA_VERSION,
    source_version: event.source.version,
    source_machine: event.source.machine,
    replay_safe: event.idempotency.replay_safe,
    replay_of_event_id: event.idempotency.replay_of_event_id,
    correlation: structuredClone(event.correlation),
    subject: structuredClone(event.subject),
    actor: structuredClone(event.actor),
    project_mappings: structuredClone(event.project_mappings),
    resource_refs: structuredClone(event.resource_refs),
    evidence_refs: structuredClone(event.evidence_refs),
    sensitivity: structuredClone(event.sensitivity),
    redaction: structuredClone(event.redaction),
    delivery: structuredClone(event.delivery)
  };
  return {
    id: event.event_id,
    source: event.source.app,
    type: event.event_type,
    time: event.occurred_at,
    subject: event.subject.uri ?? `${event.subject.kind}:${event.subject.id}`,
    severity: event.severity,
    data: structuredClone(event.data),
    message: event.summary,
    dedupeKey: event.idempotency.dedupe_key,
    schemaVersion: APP_EVENT_V1_SCHEMA_VERSION,
    metadata: { [APP_EVENT_V1_METADATA_KEY]: metadata }
  };
}
function appEventV1FromEventEnvelope(envelope) {
  const metadata = envelope.metadata[APP_EVENT_V1_METADATA_KEY];
  if (!isRecord(metadata) || metadata.profile !== APP_EVENT_V1_SCHEMA_VERSION) {
    throw new AppEventValidationError([{
      path: `metadata.${APP_EVENT_V1_METADATA_KEY}.profile`,
      message: `must equal ${APP_EVENT_V1_SCHEMA_VERSION}`
    }]);
  }
  const event = {
    event_id: envelope.id,
    event_type: envelope.type,
    schema_version: envelope.schemaVersion,
    source: {
      app: envelope.source,
      version: metadata.source_version,
      machine: metadata.source_machine
    },
    occurred_at: envelope.time,
    severity: envelope.severity,
    idempotency: {
      dedupe_key: envelope.dedupeKey,
      replay_safe: metadata.replay_safe,
      replay_of_event_id: metadata.replay_of_event_id
    },
    correlation: metadata.correlation,
    subject: metadata.subject,
    actor: metadata.actor,
    project_mappings: metadata.project_mappings,
    summary: envelope.message,
    data: structuredClone(envelope.data),
    resource_refs: metadata.resource_refs,
    evidence_refs: metadata.evidence_refs,
    sensitivity: metadata.sensitivity,
    redaction: metadata.redaction,
    delivery: metadata.delivery
  };
  assertAppEventV1(event);
  return structuredClone(event);
}
function validateSubject(value, issues) {
  const subject = requireRecord(value, "subject", issues);
  if (!subject)
    return;
  rejectUnknownKeys(subject, ["kind", "id", "uri"], "subject", issues);
  requireString2(subject, "kind", "subject.kind", issues, 100);
  requireString2(subject, "id", "subject.id", issues, 200);
  optionalString2(subject, "uri", "subject.uri", issues, 2048);
}
function validateActor(value, issues) {
  const actor = requireRecord(value, "actor", issues);
  if (!actor)
    return;
  rejectUnknownKeys(actor, ["kind", "id", "name"], "actor", issues);
  requireEnum(actor, "kind", ACTOR_KINDS, "actor.kind", issues);
  requireString2(actor, "id", "actor.id", issues, 200);
  optionalString2(actor, "name", "actor.name", issues, 200);
}
function validateProjectMappings(value, issues) {
  const project = requireRecord(value, "project_mappings", issues);
  if (!project)
    return;
  rejectUnknownKeys(project, ["canonical_id", "slug", "repository", "workspace", "external_ids"], "project_mappings", issues);
  requireString2(project, "canonical_id", "project_mappings.canonical_id", issues, 200);
  optionalString2(project, "slug", "project_mappings.slug", issues, 200);
  optionalString2(project, "repository", "project_mappings.repository", issues, 2048);
  optionalString2(project, "workspace", "project_mappings.workspace", issues, 2048);
  const externalIds = requireRecord(project, "external_ids", issues, "project_mappings.external_ids");
  if (externalIds) {
    if (Object.keys(externalIds).length > APP_EVENT_V1_MAX_TARGETS) {
      issues.push({ path: "project_mappings.external_ids", message: `must have at most ${APP_EVENT_V1_MAX_TARGETS} entries` });
    }
    for (const [key, entry] of Object.entries(externalIds)) {
      if (!key.trim() || typeof entry !== "string" || !entry.trim()) {
        issues.push({ path: `project_mappings.external_ids.${key}`, message: "keys and values must be non-empty strings" });
      }
    }
  }
}
function validateData(value, issues) {
  if (!isRecord(value)) {
    issues.push({ path: "data", message: "must be an object" });
    return;
  }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > APP_EVENT_V1_MAX_DATA_BYTES) {
      issues.push({ path: "data", message: `must serialize to at most ${APP_EVENT_V1_MAX_DATA_BYTES} UTF-8 bytes` });
    }
  } catch {
    issues.push({ path: "data", message: "must be JSON serializable" });
  }
}
function validateResourceRefs(value, issues) {
  validateRefArray(value, "resource_refs", issues, (ref, path) => {
    rejectUnknownKeys(ref, ["kind", "id", "uri", "source_package", "external_id"], path, issues);
    requireString2(ref, "kind", `${path}.kind`, issues, 100);
    requireString2(ref, "id", `${path}.id`, issues, 200);
    optionalString2(ref, "uri", `${path}.uri`, issues, 2048);
    optionalString2(ref, "source_package", `${path}.source_package`, issues, 200);
    optionalString2(ref, "external_id", `${path}.external_id`, issues, 200);
  });
}
function validateEvidenceRefs(value, issues) {
  validateRefArray(value, "evidence_refs", issues, (ref, path) => {
    rejectUnknownKeys(ref, ["kind", "id", "uri", "sha256", "redaction"], path, issues);
    requireString2(ref, "kind", `${path}.kind`, issues, 100);
    requireString2(ref, "id", `${path}.id`, issues, 200);
    requireString2(ref, "uri", `${path}.uri`, issues, 2048);
    optionalString2(ref, "sha256", `${path}.sha256`, issues, 64);
    if (typeof ref.sha256 === "string" && !/^[a-f0-9]{64}$/i.test(ref.sha256)) {
      issues.push({ path: `${path}.sha256`, message: "must be a 64-character hexadecimal digest" });
    }
    requireEnum(ref, "redaction", REDACTION_STATES, `${path}.redaction`, issues);
  });
}
function validateSensitivity(value, issues) {
  const sensitivity = requireRecord(value, "sensitivity", issues);
  if (!sensitivity)
    return;
  rejectUnknownKeys(sensitivity, ["classification", "contains_personal_data"], "sensitivity", issues);
  requireEnum(sensitivity, "classification", SENSITIVITIES, "sensitivity.classification", issues);
  requireBoolean(sensitivity, "contains_personal_data", "sensitivity.contains_personal_data", issues);
}
function validateRedaction(value, issues) {
  const redaction = requireRecord(value, "redaction", issues);
  if (!redaction)
    return;
  rejectUnknownKeys(redaction, ["state", "fields", "safe_for_logs"], "redaction", issues);
  requireEnum(redaction, "state", REDACTION_STATES, "redaction.state", issues);
  validateStringArray(redaction.fields, "redaction.fields", APP_EVENT_V1_MAX_REFS, issues, true);
  requireBoolean(redaction, "safe_for_logs", "redaction.safe_for_logs", issues);
  if (redaction.state === "none" && Array.isArray(redaction.fields) && redaction.fields.length > 0) {
    issues.push({ path: "redaction.fields", message: "must be empty when redaction.state is none" });
  }
}
function validateDelivery(value, issues) {
  const delivery = requireRecord(value, "delivery", issues);
  if (!delivery)
    return;
  rejectUnknownKeys(delivery, ["intent", "mode", "targets", "agent_conversation_injection"], "delivery", issues);
  requireEnum(delivery, "intent", DELIVERY_INTENTS, "delivery.intent", issues);
  requireEnum(delivery, "mode", DELIVERY_MODES, "delivery.mode", issues);
  validateStringArray(delivery.targets, "delivery.targets", APP_EVENT_V1_MAX_TARGETS, issues, false);
  if (delivery.agent_conversation_injection !== false) {
    issues.push({ path: "delivery.agent_conversation_injection", message: "must be false" });
  }
}
function validateRefArray(value, path, issues, validate) {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length > APP_EVENT_V1_MAX_REFS) {
    issues.push({ path, message: `must contain at most ${APP_EVENT_V1_MAX_REFS} entries` });
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry))
      issues.push({ path: `${path}.${index}`, message: "must be an object" });
    else
      validate(entry, `${path}.${index}`);
  });
}
function validateStringArray(value, path, maxItems, issues, allowEmpty) {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (!allowEmpty && value.length === 0)
    issues.push({ path, message: "must contain at least one entry" });
  if (value.length > maxItems)
    issues.push({ path, message: `must contain at most ${maxItems} entries` });
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      issues.push({ path: `${path}.${index}`, message: "must be a non-empty string" });
    }
  });
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function rejectUnknownKeys(value, allowed, path, issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
  }
}
function requireRecord(value, key, issues, path = key) {
  const entry = value[key];
  if (!isRecord(entry)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  return entry;
}
function requireString2(value, key, path, issues, maxLength) {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim())
    issues.push({ path, message: "must be a non-empty string" });
  else if (entry.length > maxLength)
    issues.push({ path, message: `must have at most ${maxLength} characters` });
}
function optionalString2(value, key, path, issues, maxLength) {
  if (value[key] === undefined)
    return;
  requireString2(value, key, path, issues, maxLength);
}
function requireBoolean(value, key, path, issues) {
  if (typeof value[key] !== "boolean")
    issues.push({ path, message: "must be a boolean" });
}
function requireEnum(value, key, allowed, path, issues) {
  if (typeof value[key] !== "string" || !allowed.includes(value[key])) {
    issues.push({ path, message: `must be one of: ${allowed.join(", ")}` });
  }
}
function requireTimestamp(value, key, issues) {
  const entry = value[key];
  if (typeof entry !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(entry) || Number.isNaN(Date.parse(entry))) {
    issues.push({ path: key, message: "must be an RFC 3339 date-time" });
  }
}

// src/index.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/redaction.ts
function redactPaths(event, paths, replacement = "[REDACTED]") {
  if (paths.length === 0)
    return event;
  const copy = structuredClone(event);
  for (const path of paths) {
    setPath(copy, path, replacement);
  }
  return copy;
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
var MAX_RETRY_ATTEMPTS = 1000;
var MAX_RETRY_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
var MAX_RETRY_MULTIPLIER = 100;
var SCHEMA_V1_TABLE_SQL = {
  channels: `CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  events: `CREATE TABLE events (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT,
    source TEXT NOT NULL,
    type TEXT NOT NULL,
    time TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  outbox: `CREATE TABLE outbox (
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
  )`,
  deliveries: `CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    channel_id TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`
};
var SCHEMA_V1_INDEX_SQL = {
  events_dedupe_key_unique: `CREATE UNIQUE INDEX events_dedupe_key_unique
    ON events(dedupe_key) WHERE dedupe_key IS NOT NULL`,
  events_source_type_idx: "CREATE INDEX events_source_type_idx ON events(source, type)",
  outbox_due_idx: "CREATE INDEX outbox_due_idx ON outbox(status, available_at, lease_expires_at)"
};
var SCHEMA_V1_COLUMNS = {
  channels: [
    { name: "id", type: "TEXT", notnull: 0, defaultValue: null, pk: 1 },
    { name: "enabled", type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 },
    { name: "config_json", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 }
  ],
  events: [
    { name: "id", type: "TEXT", notnull: 0, defaultValue: null, pk: 1 },
    { name: "dedupe_key", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "source", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "type", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "time", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "envelope_json", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 }
  ],
  outbox: [
    { name: "id", type: "TEXT", notnull: 0, defaultValue: null, pk: 1 },
    { name: "event_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "channel_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "event_json", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "channel_json", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "attempt_count", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "available_at", type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 },
    { name: "lease_owner", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "lease_expires_at", type: "INTEGER", notnull: 0, defaultValue: null, pk: 0 },
    { name: "attempts_json", type: "TEXT", notnull: 1, defaultValue: "'[]'", pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 }
  ],
  deliveries: [
    { name: "id", type: "TEXT", notnull: 0, defaultValue: null, pk: 1 },
    { name: "event_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "channel_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "result_json", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 }
  ]
};
var EVENT_FOREIGN_KEY = {
  table: "events",
  from: "event_id",
  to: "id",
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
  match: "NONE"
};
var SCHEMA_V1_FOREIGN_KEYS = {
  channels: [],
  events: [],
  outbox: [EVENT_FOREIGN_KEY],
  deliveries: [EVENT_FOREIGN_KEY]
};
var SCHEMA_V1_INDEXES = {
  channels: [
    { name: "sqlite_autoindex_channels_1", unique: 1, origin: "pk", partial: 0, columns: ["id"] }
  ],
  events: [
    { name: "events_dedupe_key_unique", unique: 1, origin: "c", partial: 1, columns: ["dedupe_key"] },
    { name: "events_source_type_idx", unique: 0, origin: "c", partial: 0, columns: ["source", "type"] },
    { name: "sqlite_autoindex_events_1", unique: 1, origin: "pk", partial: 0, columns: ["id"] }
  ],
  outbox: [
    { name: "outbox_due_idx", unique: 0, origin: "c", partial: 0, columns: ["status", "available_at", "lease_expires_at"] },
    { name: "sqlite_autoindex_outbox_1", unique: 1, origin: "pk", partial: 0, columns: ["id"] },
    { name: "sqlite_autoindex_outbox_2", unique: 1, origin: "u", partial: 0, columns: ["event_id", "channel_id"] }
  ],
  deliveries: [
    { name: "sqlite_autoindex_deliveries_1", unique: 1, origin: "pk", partial: 0, columns: ["id"] }
  ]
};
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
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.ensureSchema();
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = FULL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.secureDatabaseFiles();
    } catch (error) {
      this.db.close();
      throw error;
    }
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
    if (input.retry !== undefined)
      validateRetryPolicy(input.retry);
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
    const event = redactSensitiveKeys(createEvent({ ...input, time: input.time ?? this.now() }));
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
    const limit = normalizePositiveInteger(options.limit, 100, "limit");
    const leaseMs = normalizePositiveInteger(options.leaseMs, 60000, "leaseMs");
    const attemptedIds = new Set;
    const summary = {
      workerId,
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead: 0,
      lost: 0,
      deliveries: []
    };
    while (summary.claimed < limit) {
      const [job] = this.claim({ workerId, limit: 1, leaseMs, excludeIds: [...attemptedIds] });
      if (!job)
        break;
      attemptedIds.add(job.id);
      summary.claimed += 1;
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
      if (settled.status === "lost")
        summary.lost += 1;
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
      const excludeIds = options.excludeIds ?? [];
      const exclusion = excludeIds.length > 0 ? ` AND o.id NOT IN (${excludeIds.map(() => "?").join(", ")})` : "";
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
      `).all(nowMs, nowMs, ...excludeIds, options.limit);
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
        return { status: "lost" };
      const attempts = parseJson(row.attempts_json);
      attempts.push(attempt);
      if (attempt.status === "success") {
        const delivery2 = createDeliveryResult(job.event, job.channel, attempts);
        this.completeOutbox(job, "delivered", attempts, delivery2);
        return { status: "delivered", delivery: delivery2 };
      }
      const retry = normalizeRetryPolicy2(job.channel.retry);
      if (job.attempt < retry.maxAttempts) {
        const backoffMs = retryBackoffMs(retry, job.attempt);
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
      const channelEvent = redactPaths(event, channel.redact?.paths ?? [], channel.redact?.replacement ?? "[REDACTED]");
      const timestamp = this.now().toISOString();
      const inserted = this.db.query(`
        INSERT OR IGNORE INTO outbox (
          id, event_id, channel_id, event_json, channel_json, status,
          attempt_count, available_at, attempts_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, '[]', ?, ?)
      `).run(randomUUID3(), event.id, channel.id, JSON.stringify(channelEvent), JSON.stringify(channel), this.now().getTime(), timestamp, timestamp);
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
    const version = this.readSchemaVersion();
    if (!Number.isInteger(version) || version < 0) {
      throw new Error("Durable SQLite schema version is invalid");
    }
    if (version > DURABLE_SCHEMA_VERSION) {
      throw new Error(`Durable SQLite schema version ${version} is newer than supported version ${DURABLE_SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.immediate(() => {
        if (this.readSchemaVersion() !== 0) {
          throw new Error("Durable SQLite schema version changed during initialization");
        }
        this.assertEmptyApplicationSchema();
        this.createSchemaV1();
        this.assertSchemaV1();
        this.db.exec(`PRAGMA user_version = ${DURABLE_SCHEMA_VERSION};`);
        if (this.readSchemaVersion() !== DURABLE_SCHEMA_VERSION) {
          throw new Error("Durable SQLite schema version could not be recorded");
        }
      });
      return;
    }
    this.assertSchemaV1();
  }
  createSchemaV1() {
    for (const sql of Object.values(SCHEMA_V1_TABLE_SQL))
      this.db.exec(`${sql};`);
    for (const sql of Object.values(SCHEMA_V1_INDEX_SQL))
      this.db.exec(`${sql};`);
  }
  assertSchemaV1() {
    const objects = this.applicationSchemaObjects();
    const expectedObjects = [
      ...Object.entries(SCHEMA_V1_TABLE_SQL).map(([name, sql]) => ({ type: "table", name, table: name, sql })),
      ...Object.entries(SCHEMA_V1_INDEX_SQL).map(([name, sql]) => ({
        type: "index",
        name,
        table: schemaIndexTable(name),
        sql
      }))
    ].sort(compareSchemaObjects);
    assertSchemaShape("application objects", objects.map(({ type, name, table }) => ({ type, name, table })), expectedObjects.map(({ type, name, table }) => ({ type, name, table })));
    for (const table of Object.keys(SCHEMA_V1_TABLE_SQL)) {
      const columns = this.db.query(`PRAGMA table_info(${schemaIdentifier(table)})`).all().map((column) => ({
        name: column.name,
        type: column.type,
        notnull: Number(column.notnull),
        defaultValue: column.dflt_value,
        pk: Number(column.pk)
      }));
      assertSchemaShape(`${table} columns`, columns, SCHEMA_V1_COLUMNS[table]);
      const foreignKeys = this.db.query(`PRAGMA foreign_key_list(${schemaIdentifier(table)})`).all().map((foreignKey) => ({
        table: foreignKey.table,
        from: foreignKey.from,
        to: foreignKey.to,
        onUpdate: foreignKey.on_update,
        onDelete: foreignKey.on_delete,
        match: foreignKey.match
      })).sort((left, right) => `${left.from}:${left.table}`.localeCompare(`${right.from}:${right.table}`));
      assertSchemaShape(`${table} foreign keys`, foreignKeys, SCHEMA_V1_FOREIGN_KEYS[table]);
      const indexes = this.db.query(`PRAGMA index_list(${schemaIdentifier(table)})`).all().map((index) => ({
        name: index.name,
        unique: Number(index.unique),
        origin: index.origin,
        partial: Number(index.partial),
        columns: this.db.query(`PRAGMA index_info(${schemaIdentifier(index.name)})`).all().sort((left, right) => Number(left.seqno) - Number(right.seqno)).map((column) => column.name)
      })).sort((left, right) => left.name.localeCompare(right.name));
      const expectedIndexes = [...SCHEMA_V1_INDEXES[table]].sort((left, right) => left.name.localeCompare(right.name));
      assertSchemaShape(`${table} indexes`, indexes, expectedIndexes);
    }
    for (const expected of expectedObjects) {
      const actual = objects.find((object) => object.type === expected.type && object.name === expected.name);
      if (!actual?.sql || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) {
        throw incompatibleSchema(`${expected.type} ${expected.name} SQL`);
      }
    }
  }
  readSchemaVersion() {
    const row = this.db.query("PRAGMA user_version").get();
    return Number(row?.user_version);
  }
  applicationSchemaObjects() {
    return this.db.query(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE substr(name, 1, 7) <> 'sqlite_'
      ORDER BY type, name
    `).all().map((row) => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: row.sql
    }));
  }
  assertEmptyApplicationSchema() {
    if (this.applicationSchemaObjects().length !== 0) {
      throw new Error("Durable SQLite schema version 0 requires an empty application schema");
    }
  }
  secureDatabaseFiles() {
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync2(path))
        continue;
      chmodSync(path, 384);
    }
  }
}
function schemaIndexTable(name) {
  if (name === "events_dedupe_key_unique" || name === "events_source_type_idx")
    return "events";
  if (name === "outbox_due_idx")
    return "outbox";
  throw new Error(`Unknown durable schema index: ${name}`);
}
function schemaIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error("Invalid durable schema identifier");
  return value;
}
function compareSchemaObjects(left, right) {
  return `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`);
}
function normalizeSchemaSql(sql) {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").toLowerCase();
}
function assertSchemaShape(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw incompatibleSchema(label);
}
function incompatibleSchema(detail) {
  return new Error(`Durable SQLite schema version 1 is incompatible: ${detail}`);
}
function normalizePositiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error(`${name} must be a positive integer`);
  return resolved;
}
function normalizeRetryPolicy2(policy) {
  const normalized = {
    maxAttempts: policy?.maxAttempts ?? 1,
    backoffMs: policy?.backoffMs ?? 250,
    multiplier: policy?.multiplier ?? 2
  };
  validateRetryPolicy(normalized);
  return normalized;
}
function validateRetryPolicy(policy) {
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
  if (maxAttempts > 1)
    retryBackoffMs({ maxAttempts, backoffMs, multiplier }, maxAttempts - 1);
}
function retryBackoffMs(policy, attempt) {
  const delay = Math.round(policy.backoffMs * policy.multiplier ** (attempt - 1));
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_RETRY_DELAY_MS) {
    throw new Error(`retry policy must not produce a delay above ${MAX_RETRY_DELAY_MS}ms`);
  }
  return delay;
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
    if (/^x-hasna-/i.test(name)) {
      throw new Error("Durable webhook X-Hasna headers are reserved for signed delivery metadata");
    }
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
export {
  defaultWebhookSecretResolver,
  DurableEventsBroker
};
