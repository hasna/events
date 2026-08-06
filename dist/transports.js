// @bun
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
export {
  dispatchWebhook,
  dispatchCommand,
  dispatchChannel,
  createDeliveryResult,
  buildWebhookRequest
};
