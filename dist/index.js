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
export {
  verifyWebhookSignature,
  verifyPayloadSignature,
  validateRolloutData,
  validateReleasePublishedData,
  validateFeedbackTriagedData,
  validateFeedbackCreatedData,
  validateAppInstalledData,
  validateAppEventV1,
  validateAnnouncementSentData,
  signPayload,
  sanitizeChannelsForOutput,
  sanitizeChannelForOutput,
  registerDistributionEventTypes,
  redactSensitiveKeys,
  redactPaths,
  normalizeEventPageLimit,
  matchString,
  localJsonRuntime,
  isTimestampWithinTolerance,
  getEventsStatus,
  getEventsDataDir,
  getActiveEventsDirEnv,
  eventMatchesFilter,
  encodeLocalJsonEventCursor,
  dispatchWebhook,
  dispatchCommand,
  dispatchChannel,
  defaultEventTypeCatalog,
  decodeLocalJsonEventCursor,
  createEvent,
  createDistributionEventDefinitions,
  createDeliveryResult,
  channelMatchesEvent,
  buildWebhookRequest,
  buildSignatureBase,
  assertAppEventV1ReplaySafe,
  assertAppEventV1,
  appEventV1ToEventInput,
  appEventV1ReplayIdentity,
  appEventV1FromEventEnvelope,
  MAX_EVENT_PAGE_LIMIT,
  LOCAL_JSON_EVENT_CURSOR_PREFIX,
  JsonEventsStore,
  HASNA_EVENTS_HOME_ENV,
  HASNA_EVENTS_DIR_ENV,
  EventsClient,
  EventValidationError,
  EventTypeCatalog,
  DISTRIBUTION_EVENT_TYPES,
  DISTRIBUTION_EVENT_CONTRACT_SCHEMAS,
  DEFAULT_SIGNATURE_TOLERANCE_MS,
  DEFAULT_EVENT_PAGE_LIMIT,
  AppEventValidationError,
  AppEventReplaySafetyError,
  APP_EVENT_V1_SCHEMA_VERSION,
  APP_EVENT_V1_METADATA_KEY,
  APP_EVENT_V1_MAX_TARGETS,
  APP_EVENT_V1_MAX_SUMMARY_LENGTH,
  APP_EVENT_V1_MAX_REFS,
  APP_EVENT_V1_MAX_DATA_BYTES
};
