export type EventSeverity = "debug" | "info" | "notice" | "warning" | "error" | "critical";

export type EventData = Record<string, unknown>;

export interface EventEnvelope<TData extends EventData = EventData> {
  id: string;
  source: string;
  type: string;
  time: string;
  subject?: string;
  severity: EventSeverity;
  data: TData;
  message?: string;
  dedupeKey?: string;
  schemaVersion: string;
  metadata: Record<string, unknown>;
}

export interface EventInput<TData extends EventData = EventData> {
  id?: string;
  source: string;
  type: string;
  time?: string | Date;
  subject?: string;
  severity?: EventSeverity;
  data?: TData;
  message?: string;
  dedupeKey?: string;
  schemaVersion?: string;
  metadata?: Record<string, unknown>;
}

export type StringMatcher = string | string[];

export interface EventFilter {
  source?: StringMatcher;
  type?: StringMatcher;
  subject?: StringMatcher;
  severity?: StringMatcher;
  data?: Record<string, StringMatcher | number | boolean | null>;
  metadata?: Record<string, StringMatcher | number | boolean | null>;
}

export interface RetryPolicy {
  maxAttempts?: number;
  backoffMs?: number;
  multiplier?: number;
}

export interface RedactionConfig {
  paths?: string[];
  replacement?: string;
}

export interface WebhookTransportConfig {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface CommandTransportConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type TransportKind = "webhook" | "command" | "email" | "sse" | "mcp-relay";

export interface ChannelConfig {
  id: string;
  name?: string;
  enabled: boolean;
  transport: TransportKind;
  filters?: EventFilter[];
  webhook?: WebhookTransportConfig;
  command?: CommandTransportConfig;
  retry?: RetryPolicy;
  redact?: RedactionConfig;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryAttempt {
  attempt: number;
  status: "success" | "failed" | "skipped";
  startedAt: string;
  completedAt: string;
  responseStatus?: number;
  responseBody?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  nextBackoffMs?: number;
}

export interface DeliveryResult {
  id: string;
  eventId: string;
  channelId: string;
  transport: TransportKind;
  status: "success" | "failed" | "skipped";
  attempts: DeliveryAttempt[];
  createdAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}

export type EventRedactor = (
  event: EventEnvelope,
  channel: ChannelConfig,
) => EventEnvelope | Promise<EventEnvelope>;

export interface EmitOptions {
  deliver?: boolean;
  dedupe?: boolean;
  redactSensitiveData?: boolean;
}

export interface ReplayOptions {
  eventId?: string;
  source?: string;
  type?: string;
  dryRun?: boolean;
}

export interface StoredEventsData {
  channels: ChannelConfig[];
  events: EventEnvelope[];
  deliveries: DeliveryResult[];
}

export interface EmitResult<TData extends EventData = EventData> {
  event: EventEnvelope<TData>;
  deliveries: DeliveryResult[];
  deduped: boolean;
}
