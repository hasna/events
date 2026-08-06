import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChannelConfig, DeliveryAttempt, DeliveryResult, EventEnvelope } from "./types.js";
import { signPayload } from "./signing.js";

export interface TransportDispatchOptions {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  secretResolver?: WebhookSecretResolver;
  now?: () => Date;
}

export type WebhookSecretResolver = (reference: string) => string | undefined | Promise<string | undefined>;

export interface BuildWebhookRequestOptions {
  secret?: string;
  timestamp?: string;
}

function now(): string {
  return new Date().toISOString();
}

function truncate(value: string, max = 4096): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function buildWebhookRequest(
  event: EventEnvelope,
  channel: ChannelConfig,
  options: BuildWebhookRequestOptions = {},
): { body: string; headers: Record<string, string> } {
  if (!channel.webhook) throw new Error(`Channel ${channel.id} has no webhook config`);
  for (const name of Object.keys(channel.webhook.headers ?? {})) {
    if (/^x-hasna-/i.test(name)) {
      throw new Error(`Webhook header ${name} is reserved for signed delivery metadata`);
    }
  }
  const body = JSON.stringify(event);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "@hasna/events",
    "X-Hasna-Event-Id": event.id,
    "X-Hasna-Event-Type": event.type,
    ...channel.webhook.headers,
    "X-Hasna-Timestamp": timestamp,
  };
  const secret = options.secret ?? channel.webhook.secret;
  if (secret) {
    headers["X-Hasna-Signature"] = signPayload(secret, timestamp, body);
  }
  return { body, headers };
}

export async function dispatchWebhook(event: EventEnvelope, channel: ChannelConfig, options: TransportDispatchOptions = {}): Promise<DeliveryAttempt> {
  if (!channel.webhook) throw new Error(`Channel ${channel.id} has no webhook config`);
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
    if (!secret) return failedAttempt(startedAt, "Webhook secret reference could not be resolved");
  }
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const { body, headers } = buildWebhookRequest(event, channel, { secret, timestamp });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), channel.webhook.timeoutMs ?? 15_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(channel.webhook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const responseBody = truncate(await response.text());
    return {
      attempt: 1,
      status: response.ok ? "success" : "failed",
      startedAt,
      completedAt: now(),
      responseStatus: response.status,
      responseBody,
      error: response.ok ? undefined : `Webhook returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      attempt: 1,
      status: "failed",
      startedAt,
      completedAt: now(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function failedAttempt(startedAt: string, error: string): DeliveryAttempt {
  return {
    attempt: 1,
    status: "failed",
    startedAt,
    completedAt: now(),
    error,
  };
}

export async function dispatchCommand(event: EventEnvelope, channel: ChannelConfig): Promise<DeliveryAttempt> {
  if (!channel.command) throw new Error(`Channel ${channel.id} has no command config`);
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
    HASNA_EVENT_JSON: eventJson,
  };

  return new Promise((resolve) => {
    const child = spawn(channel.command!.command, channel.command!.args ?? [], {
      cwd: channel.command!.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), channel.command!.timeoutMs ?? 15_000);
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
        error: error.message,
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
        error: success ? undefined : `Command exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
      });
    });
  });
}

export async function dispatchChannel(event: EventEnvelope, channel: ChannelConfig, options: TransportDispatchOptions = {}): Promise<DeliveryAttempt> {
  if (channel.transport === "webhook") return dispatchWebhook(event, channel, options);
  if (channel.transport === "command") return dispatchCommand(event, channel);
  return {
    attempt: 1,
    status: "skipped",
    startedAt: now(),
    completedAt: now(),
    error: `Unsupported transport: ${channel.transport}`,
  };
}

export function createDeliveryResult(event: EventEnvelope, channel: ChannelConfig, attempts: DeliveryAttempt[]): DeliveryResult {
  const status = attempts.some((attempt) => attempt.status === "success")
    ? "success"
    : attempts.every((attempt) => attempt.status === "skipped")
      ? "skipped"
      : "failed";
  return {
    id: randomUUID(),
    eventId: event.id,
    channelId: channel.id,
    transport: channel.transport,
    status,
    attempts,
    createdAt: attempts[0]?.startedAt ?? now(),
    completedAt: attempts.at(-1)?.completedAt ?? now(),
  };
}
