import type { EventData, EventEnvelope, EventInput, EventSeverity } from "./types.js";

/** Stable wire-profile identifier for cross-app events. */
export const APP_EVENT_V1_SCHEMA_VERSION = "hasna.app_event.v1" as const;
export const APP_EVENT_V1_METADATA_KEY = "app_event" as const;
export const APP_EVENT_V1_MAX_SUMMARY_LENGTH = 512;
export const APP_EVENT_V1_MAX_DATA_BYTES = 32 * 1024;
export const APP_EVENT_V1_MAX_REFS = 32;
export const APP_EVENT_V1_MAX_TARGETS = 16;

export type AppEventActorKind = "agent" | "human" | "service" | "model" | "workflow" | "system";
export type AppEventSensitivity = "public" | "internal" | "confidential" | "restricted";
export type AppEventRedactionState = "none" | "partial" | "full";
export type AppEventDeliveryIntent = "notification" | "state_sync" | "audit" | "command";
export type AppEventDeliveryMode = "at_most_once" | "at_least_once";

export interface AppEventSource {
  app: string;
  version: string;
  machine: string;
}

export interface AppEventIdempotency {
  dedupe_key: string;
  replay_safe: boolean;
  replay_of_event_id?: string;
}

export interface AppEventCorrelation {
  correlation_id: string;
  causation_id?: string;
  trace_id?: string;
}

export interface AppEventSubject {
  kind: string;
  id: string;
  uri?: string;
}

export interface AppEventActor {
  kind: AppEventActorKind;
  id: string;
  name?: string;
}

export interface AppEventProjectMappings {
  canonical_id: string;
  slug?: string;
  repository?: string;
  workspace?: string;
  external_ids: Record<string, string>;
}

/** Dependency-free structural mirror of a hasna.resource_ref pointer. */
export interface AppEventResourceRef {
  kind: string;
  id: string;
  uri?: string;
  source_package?: string;
  external_id?: string;
}

/** Dependency-free structural mirror of a hasna.evidence_ref pointer. */
export interface AppEventEvidenceRef {
  kind: string;
  id: string;
  uri: string;
  sha256?: string;
  redaction: AppEventRedactionState;
}

export interface AppEventSensitivityPolicy {
  classification: AppEventSensitivity;
  contains_personal_data: boolean;
}

export interface AppEventRedaction {
  state: AppEventRedactionState;
  fields: string[];
  safe_for_logs: boolean;
}

export interface AppEventDelivery {
  intent: AppEventDeliveryIntent;
  mode: AppEventDeliveryMode;
  targets: string[];
  /** Untrusted event text is data, never an instruction to an agent. */
  agent_conversation_injection: false;
}

/**
 * Cross-app wire profile carried by the existing @hasna/events envelope.
 * Use {@link appEventV1ToEventInput}; this profile does not define another bus.
 */
export interface AppEventV1<TData extends EventData = EventData> {
  event_id: string;
  event_type: string;
  schema_version: typeof APP_EVENT_V1_SCHEMA_VERSION;
  source: AppEventSource;
  occurred_at: string;
  severity: EventSeverity;
  idempotency: AppEventIdempotency;
  correlation: AppEventCorrelation;
  subject: AppEventSubject;
  actor: AppEventActor;
  project_mappings: AppEventProjectMappings;
  summary: string;
  data: TData;
  resource_refs: AppEventResourceRef[];
  evidence_refs: AppEventEvidenceRef[];
  sensitivity: AppEventSensitivityPolicy;
  redaction: AppEventRedaction;
  delivery: AppEventDelivery;
}

export interface AppEventValidationIssue {
  path: string;
  message: string;
}

export type AppEventValidationResult =
  | { ok: true }
  | { ok: false; issues: AppEventValidationIssue[] };

export class AppEventValidationError extends Error {
  readonly issues: AppEventValidationIssue[];

  constructor(issues: AppEventValidationIssue[]) {
    super(`Invalid ${APP_EVENT_V1_SCHEMA_VERSION}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "AppEventValidationError";
    this.issues = issues;
  }
}

export class AppEventReplaySafetyError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`App event ${eventId} is not marked replay-safe`);
    this.name = "AppEventReplaySafetyError";
    this.eventId = eventId;
  }
}

interface AppEventEnvelopeMetadata {
  profile: typeof APP_EVENT_V1_SCHEMA_VERSION;
  source_version: string;
  source_machine: string;
  replay_safe: boolean;
  replay_of_event_id?: string;
  correlation: AppEventCorrelation;
  subject: AppEventSubject;
  actor: AppEventActor;
  project_mappings: AppEventProjectMappings;
  resource_refs: AppEventResourceRef[];
  evidence_refs: AppEventEvidenceRef[];
  sensitivity: AppEventSensitivityPolicy;
  redaction: AppEventRedaction;
  delivery: AppEventDelivery;
}

const SEVERITIES: readonly EventSeverity[] = ["debug", "info", "notice", "warning", "error", "critical"];
const ACTOR_KINDS: readonly AppEventActorKind[] = ["agent", "human", "service", "model", "workflow", "system"];
const SENSITIVITIES: readonly AppEventSensitivity[] = ["public", "internal", "confidential", "restricted"];
const REDACTION_STATES: readonly AppEventRedactionState[] = ["none", "partial", "full"];
const DELIVERY_INTENTS: readonly AppEventDeliveryIntent[] = ["notification", "state_sync", "audit", "command"];
const DELIVERY_MODES: readonly AppEventDeliveryMode[] = ["at_most_once", "at_least_once"];

export function validateAppEventV1(value: unknown): AppEventValidationResult {
  const issues: AppEventValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [{ path: "<root>", message: "must be an object" }] };

  rejectUnknownKeys(value, [
    "event_id", "event_type", "schema_version", "source", "occurred_at", "severity",
    "idempotency", "correlation", "subject", "actor", "project_mappings", "summary",
    "data", "resource_refs", "evidence_refs", "sensitivity", "redaction", "delivery",
  ], "", issues);
  requireString(value, "event_id", "event_id", issues, 200);
  requireString(value, "event_type", "event_type", issues, 200);
  if (value.schema_version !== APP_EVENT_V1_SCHEMA_VERSION) {
    issues.push({ path: "schema_version", message: `must equal ${APP_EVENT_V1_SCHEMA_VERSION}` });
  }
  requireTimestamp(value, "occurred_at", issues);
  requireEnum(value, "severity", SEVERITIES, "severity", issues);
  requireString(value, "summary", "summary", issues, APP_EVENT_V1_MAX_SUMMARY_LENGTH);

  const source = requireRecord(value, "source", issues);
  if (source) {
    rejectUnknownKeys(source, ["app", "version", "machine"], "source", issues);
    requireString(source, "app", "source.app", issues, 200);
    requireString(source, "version", "source.version", issues, 100);
    requireString(source, "machine", "source.machine", issues, 200);
  }

  const idempotency = requireRecord(value, "idempotency", issues);
  if (idempotency) {
    rejectUnknownKeys(idempotency, ["dedupe_key", "replay_safe", "replay_of_event_id"], "idempotency", issues);
    requireString(idempotency, "dedupe_key", "idempotency.dedupe_key", issues, 512);
    requireBoolean(idempotency, "replay_safe", "idempotency.replay_safe", issues);
    optionalString(idempotency, "replay_of_event_id", "idempotency.replay_of_event_id", issues, 200);
    if (idempotency.replay_of_event_id === value.event_id) {
      issues.push({ path: "idempotency.replay_of_event_id", message: "must not reference the event itself" });
    }
  }

  const correlation = requireRecord(value, "correlation", issues);
  if (correlation) {
    rejectUnknownKeys(correlation, ["correlation_id", "causation_id", "trace_id"], "correlation", issues);
    requireString(correlation, "correlation_id", "correlation.correlation_id", issues, 200);
    optionalString(correlation, "causation_id", "correlation.causation_id", issues, 200);
    optionalString(correlation, "trace_id", "correlation.trace_id", issues, 200);
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

export function assertAppEventV1<TData extends EventData = EventData>(value: unknown): asserts value is AppEventV1<TData> {
  const result = validateAppEventV1(value);
  if (!result.ok) throw new AppEventValidationError(result.issues);
}

export function assertAppEventV1ReplaySafe(event: AppEventV1): void {
  assertAppEventV1(event);
  if (!event.idempotency.replay_safe) throw new AppEventReplaySafetyError(event.event_id);
}

export function appEventV1ReplayIdentity(event: AppEventV1): { eventId: string; dedupeKey: string } {
  assertAppEventV1ReplaySafe(event);
  return { eventId: event.event_id, dedupeKey: event.idempotency.dedupe_key };
}

/** Map the profile onto the existing @hasna/events envelope without another transport or store. */
export function appEventV1ToEventInput<TData extends EventData>(event: AppEventV1<TData>): EventInput<TData> {
  assertAppEventV1<TData>(event);
  const metadata: AppEventEnvelopeMetadata = {
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
    delivery: structuredClone(event.delivery),
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
    metadata: { [APP_EVENT_V1_METADATA_KEY]: metadata },
  };
}

/** Reconstruct a profile from an @hasna/events envelope produced by the adapter. */
export function appEventV1FromEventEnvelope<TData extends EventData = EventData>(envelope: EventEnvelope<TData>): AppEventV1<TData> {
  const metadata = envelope.metadata[APP_EVENT_V1_METADATA_KEY];
  if (!isRecord(metadata) || metadata.profile !== APP_EVENT_V1_SCHEMA_VERSION) {
    throw new AppEventValidationError([{
      path: `metadata.${APP_EVENT_V1_METADATA_KEY}.profile`,
      message: `must equal ${APP_EVENT_V1_SCHEMA_VERSION}`,
    }]);
  }
  const event = {
    event_id: envelope.id,
    event_type: envelope.type,
    schema_version: envelope.schemaVersion,
    source: {
      app: envelope.source,
      version: metadata.source_version,
      machine: metadata.source_machine,
    },
    occurred_at: envelope.time,
    severity: envelope.severity,
    idempotency: {
      dedupe_key: envelope.dedupeKey,
      replay_safe: metadata.replay_safe,
      replay_of_event_id: metadata.replay_of_event_id,
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
    delivery: metadata.delivery,
  };
  assertAppEventV1<TData>(event);
  return structuredClone(event);
}

function validateSubject(value: Record<string, unknown>, issues: AppEventValidationIssue[]): void {
  const subject = requireRecord(value, "subject", issues);
  if (!subject) return;
  rejectUnknownKeys(subject, ["kind", "id", "uri"], "subject", issues);
  requireString(subject, "kind", "subject.kind", issues, 100);
  requireString(subject, "id", "subject.id", issues, 200);
  optionalString(subject, "uri", "subject.uri", issues, 2048);
}

function validateActor(value: Record<string, unknown>, issues: AppEventValidationIssue[]): void {
  const actor = requireRecord(value, "actor", issues);
  if (!actor) return;
  rejectUnknownKeys(actor, ["kind", "id", "name"], "actor", issues);
  requireEnum(actor, "kind", ACTOR_KINDS, "actor.kind", issues);
  requireString(actor, "id", "actor.id", issues, 200);
  optionalString(actor, "name", "actor.name", issues, 200);
}

function validateProjectMappings(value: Record<string, unknown>, issues: AppEventValidationIssue[]): void {
  const project = requireRecord(value, "project_mappings", issues);
  if (!project) return;
  rejectUnknownKeys(project, ["canonical_id", "slug", "repository", "workspace", "external_ids"], "project_mappings", issues);
  requireString(project, "canonical_id", "project_mappings.canonical_id", issues, 200);
  optionalString(project, "slug", "project_mappings.slug", issues, 200);
  optionalString(project, "repository", "project_mappings.repository", issues, 2048);
  optionalString(project, "workspace", "project_mappings.workspace", issues, 2048);
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

function validateData(value: unknown, issues: AppEventValidationIssue[]): void {
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

function validateResourceRefs(value: unknown, issues: AppEventValidationIssue[]): void {
  validateRefArray(value, "resource_refs", issues, (ref, path) => {
    rejectUnknownKeys(ref, ["kind", "id", "uri", "source_package", "external_id"], path, issues);
    requireString(ref, "kind", `${path}.kind`, issues, 100);
    requireString(ref, "id", `${path}.id`, issues, 200);
    optionalString(ref, "uri", `${path}.uri`, issues, 2048);
    optionalString(ref, "source_package", `${path}.source_package`, issues, 200);
    optionalString(ref, "external_id", `${path}.external_id`, issues, 200);
  });
}

function validateEvidenceRefs(value: unknown, issues: AppEventValidationIssue[]): void {
  validateRefArray(value, "evidence_refs", issues, (ref, path) => {
    rejectUnknownKeys(ref, ["kind", "id", "uri", "sha256", "redaction"], path, issues);
    requireString(ref, "kind", `${path}.kind`, issues, 100);
    requireString(ref, "id", `${path}.id`, issues, 200);
    requireString(ref, "uri", `${path}.uri`, issues, 2048);
    optionalString(ref, "sha256", `${path}.sha256`, issues, 64);
    if (typeof ref.sha256 === "string" && !/^[a-f0-9]{64}$/i.test(ref.sha256)) {
      issues.push({ path: `${path}.sha256`, message: "must be a 64-character hexadecimal digest" });
    }
    requireEnum(ref, "redaction", REDACTION_STATES, `${path}.redaction`, issues);
  });
}

function validateSensitivity(value: Record<string, unknown>, issues: AppEventValidationIssue[]): void {
  const sensitivity = requireRecord(value, "sensitivity", issues);
  if (!sensitivity) return;
  rejectUnknownKeys(sensitivity, ["classification", "contains_personal_data"], "sensitivity", issues);
  requireEnum(sensitivity, "classification", SENSITIVITIES, "sensitivity.classification", issues);
  requireBoolean(sensitivity, "contains_personal_data", "sensitivity.contains_personal_data", issues);
}

function validateRedaction(value: Record<string, unknown>, issues: AppEventValidationIssue[]): void {
  const redaction = requireRecord(value, "redaction", issues);
  if (!redaction) return;
  rejectUnknownKeys(redaction, ["state", "fields", "safe_for_logs"], "redaction", issues);
  requireEnum(redaction, "state", REDACTION_STATES, "redaction.state", issues);
  validateStringArray(redaction.fields, "redaction.fields", APP_EVENT_V1_MAX_REFS, issues, true);
  requireBoolean(redaction, "safe_for_logs", "redaction.safe_for_logs", issues);
  if (redaction.state === "none" && Array.isArray(redaction.fields) && redaction.fields.length > 0) {
    issues.push({ path: "redaction.fields", message: "must be empty when redaction.state is none" });
  }
}

function validateDelivery(value: Record<string, unknown>, issues: AppEventValidationIssue[]): void {
  const delivery = requireRecord(value, "delivery", issues);
  if (!delivery) return;
  rejectUnknownKeys(delivery, ["intent", "mode", "targets", "agent_conversation_injection"], "delivery", issues);
  requireEnum(delivery, "intent", DELIVERY_INTENTS, "delivery.intent", issues);
  requireEnum(delivery, "mode", DELIVERY_MODES, "delivery.mode", issues);
  validateStringArray(delivery.targets, "delivery.targets", APP_EVENT_V1_MAX_TARGETS, issues, false);
  if (delivery.agent_conversation_injection !== false) {
    issues.push({ path: "delivery.agent_conversation_injection", message: "must be false" });
  }
}

function validateRefArray(
  value: unknown,
  path: string,
  issues: AppEventValidationIssue[],
  validate: (ref: Record<string, unknown>, path: string) => void,
): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length > APP_EVENT_V1_MAX_REFS) {
    issues.push({ path, message: `must contain at most ${APP_EVENT_V1_MAX_REFS} entries` });
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry)) issues.push({ path: `${path}.${index}`, message: "must be an object" });
    else validate(entry, `${path}.${index}`);
  });
}

function validateStringArray(value: unknown, path: string, maxItems: number, issues: AppEventValidationIssue[], allowEmpty: boolean): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (!allowEmpty && value.length === 0) issues.push({ path, message: "must contain at least one entry" });
  if (value.length > maxItems) issues.push({ path, message: `must contain at most ${maxItems} entries` });
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      issues.push({ path: `${path}.${index}`, message: "must be a non-empty string" });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: AppEventValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
  }
}

function requireRecord(
  value: Record<string, unknown>,
  key: string,
  issues: AppEventValidationIssue[],
  path = key,
): Record<string, unknown> | undefined {
  const entry = value[key];
  if (!isRecord(entry)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  return entry;
}

function requireString(value: Record<string, unknown>, key: string, path: string, issues: AppEventValidationIssue[], maxLength: number): void {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim()) issues.push({ path, message: "must be a non-empty string" });
  else if (entry.length > maxLength) issues.push({ path, message: `must have at most ${maxLength} characters` });
}

function optionalString(value: Record<string, unknown>, key: string, path: string, issues: AppEventValidationIssue[], maxLength: number): void {
  if (value[key] === undefined) return;
  requireString(value, key, path, issues, maxLength);
}

function requireBoolean(value: Record<string, unknown>, key: string, path: string, issues: AppEventValidationIssue[]): void {
  if (typeof value[key] !== "boolean") issues.push({ path, message: "must be a boolean" });
}

function requireEnum(value: Record<string, unknown>, key: string, allowed: readonly string[], path: string, issues: AppEventValidationIssue[]): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as string)) {
    issues.push({ path, message: `must be one of: ${allowed.join(", ")}` });
  }
}

function requireTimestamp(value: Record<string, unknown>, key: string, issues: AppEventValidationIssue[]): void {
  const entry = value[key];
  if (typeof entry !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(entry) || Number.isNaN(Date.parse(entry))) {
    issues.push({ path: key, message: "must be an RFC 3339 date-time" });
  }
}
