// @bun
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
  requireString(subject, "kind", "subject.kind", issues, 100);
  requireString(subject, "id", "subject.id", issues, 200);
  optionalString(subject, "uri", "subject.uri", issues, 2048);
}
function validateActor(value, issues) {
  const actor = requireRecord(value, "actor", issues);
  if (!actor)
    return;
  rejectUnknownKeys(actor, ["kind", "id", "name"], "actor", issues);
  requireEnum(actor, "kind", ACTOR_KINDS, "actor.kind", issues);
  requireString(actor, "id", "actor.id", issues, 200);
  optionalString(actor, "name", "actor.name", issues, 200);
}
function validateProjectMappings(value, issues) {
  const project = requireRecord(value, "project_mappings", issues);
  if (!project)
    return;
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
    requireString(ref, "kind", `${path}.kind`, issues, 100);
    requireString(ref, "id", `${path}.id`, issues, 200);
    optionalString(ref, "uri", `${path}.uri`, issues, 2048);
    optionalString(ref, "source_package", `${path}.source_package`, issues, 200);
    optionalString(ref, "external_id", `${path}.external_id`, issues, 200);
  });
}
function validateEvidenceRefs(value, issues) {
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
function requireString(value, key, path, issues, maxLength) {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim())
    issues.push({ path, message: "must be a non-empty string" });
  else if (entry.length > maxLength)
    issues.push({ path, message: `must have at most ${maxLength} characters` });
}
function optionalString(value, key, path, issues, maxLength) {
  if (value[key] === undefined)
    return;
  requireString(value, key, path, issues, maxLength);
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
export {
  validateAppEventV1,
  assertAppEventV1ReplaySafe,
  assertAppEventV1,
  appEventV1ToEventInput,
  appEventV1ReplayIdentity,
  appEventV1FromEventEnvelope,
  AppEventValidationError,
  AppEventReplaySafetyError,
  APP_EVENT_V1_SCHEMA_VERSION,
  APP_EVENT_V1_METADATA_KEY,
  APP_EVENT_V1_MAX_TARGETS,
  APP_EVENT_V1_MAX_SUMMARY_LENGTH,
  APP_EVENT_V1_MAX_REFS,
  APP_EVENT_V1_MAX_DATA_BYTES
};
