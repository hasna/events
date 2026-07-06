import type { EventData, EventEnvelope } from "./types.js";

// ---------------------------------------------------------------------------
// Typed event catalog (Hasna distribution apps plan)
//
// Binds event envelope `type` strings to the `@hasna/contracts` schema ids
// their `data` payloads mirror, and provides an OPT-IN emit-time validator
// hook. Validation is off by default and only ever applies to REGISTERED
// types: unregistered/free-form event types keep working untouched, so the
// ~50 packages that emit ad-hoc events through `@hasna/events` are unaffected
// unless they opt in.
//
// The payload types below are intentionally dependency-free structural
// mirrors of the corresponding `@hasna/contracts` distribution schemas
// (`hasna.app.v1`, `hasna.release.v1`, `hasna.rollout_record.v1`,
// `hasna.announcement.v1`, `hasna.audience.v1`). This package does not take a
// runtime dependency on `@hasna/contracts`.
// ---------------------------------------------------------------------------

export interface EventValidationIssue {
  path: string;
  message: string;
}

export type EventValidationResult = { ok: true } | { ok: false; issues: EventValidationIssue[] };

export type EventDataValidator = (data: EventData, event: EventEnvelope) => EventValidationResult;

export interface EventTypeDefinition {
  /** Envelope `type` string this definition binds, e.g. `release.published`. */
  type: string;
  /** `@hasna/contracts` schema id the payload mirrors, e.g. `hasna.release.v1`. */
  contractSchemaId?: string;
  description?: string;
  validate: EventDataValidator;
}

export class EventValidationError extends Error {
  readonly eventType: string;
  readonly issues: EventValidationIssue[];

  constructor(eventType: string, issues: EventValidationIssue[]) {
    const detail = issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
    super(`Event validation failed for type "${eventType}": ${detail}`);
    this.name = "EventValidationError";
    this.eventType = eventType;
    this.issues = issues;
  }
}

export class EventTypeCatalog {
  private definitions = new Map<string, EventTypeDefinition>();

  register(definition: EventTypeDefinition): this {
    this.definitions.set(definition.type, definition);
    return this;
  }

  unregister(type: string): boolean {
    return this.definitions.delete(type);
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  get(type: string): EventTypeDefinition | undefined {
    return this.definitions.get(type);
  }

  list(): EventTypeDefinition[] {
    return [...this.definitions.values()];
  }

  /**
   * Validate an event against its registered definition. Events whose type is
   * NOT registered always pass: free-form types stay untouched.
   */
  validateEvent(event: EventEnvelope): EventValidationResult {
    const definition = this.definitions.get(event.type);
    if (!definition) return { ok: true };
    return definition.validate(event.data, event);
  }

  /** Like {@link validateEvent} but throws {@link EventValidationError}. */
  assertEventValid(event: EventEnvelope): void {
    const result = this.validateEvent(event);
    if (!result.ok) {
      throw new EventValidationError(event.type, result.issues);
    }
  }
}

/** Shared default catalog used by `EventsClient` when none is provided. */
export const defaultEventTypeCatalog = new EventTypeCatalog();

// ---------------------------------------------------------------------------
// Distribution event types
// ---------------------------------------------------------------------------

export const DISTRIBUTION_EVENT_TYPES = {
  releasePublished: "release.published",
  rolloutStarted: "release.rollout.started",
  rolloutCompleted: "release.rollout.completed",
  rolloutFailed: "release.rollout.failed",
  appInstalled: "app.installed",
  announcementSent: "announcement.sent",
  feedbackCreated: "feedback.created",
  feedbackTriaged: "feedback.triaged",
} as const;

export type DistributionEventType = (typeof DISTRIBUTION_EVENT_TYPES)[keyof typeof DISTRIBUTION_EVENT_TYPES];

/** Contracts schema id each distribution event payload mirrors. */
export const DISTRIBUTION_EVENT_CONTRACT_SCHEMAS: Record<DistributionEventType, string> = {
  "release.published": "hasna.release.v1",
  "release.rollout.started": "hasna.rollout_record.v1",
  "release.rollout.completed": "hasna.rollout_record.v1",
  "release.rollout.failed": "hasna.rollout_record.v1",
  "app.installed": "hasna.rollout_record.v1",
  "announcement.sent": "hasna.announcement.v1",
  "feedback.created": "hasna.feedback.v1",
  "feedback.triaged": "hasna.feedback.v1",
};

export type PublishPath = "skill" | "ci" | "backfilled";
export type RolloutAction = "install" | "update" | "rollback" | "freeze-blocked";

/** Payload for `release.published`; mirrors `hasna.release.v1` key fields. */
export type ReleasePublishedData = {
  appId: string;
  package: string;
  version: string;
  gitSha?: string;
  publishedAt?: string;
  publishPath?: PublishPath;
  changelogRef?: string;
  [key: string]: unknown;
};

/** Payload for `release.rollout.*`; mirrors `hasna.rollout_record.v1` key fields. */
export type RolloutData = {
  appId: string;
  package: string;
  version: string;
  machine: string;
  action?: RolloutAction;
  result?: string;
  error?: string;
  [key: string]: unknown;
};

/** Payload for `app.installed`; mirrors `hasna.rollout_record.v1` (action install). */
export type AppInstalledData = {
  appId: string;
  package: string;
  version: string;
  machine: string;
  [key: string]: unknown;
};

/** Payload for `announcement.sent`; mirrors `hasna.announcement.v1` key fields. */
export type AnnouncementSentData = {
  campaignId: string;
  appId?: string;
  audienceId?: string;
  releaseId?: string;
  channels?: string[];
  [key: string]: unknown;
};

/** Payload for `feedback.created`. */
export type FeedbackCreatedData = {
  feedbackId: string;
  appId?: string;
  source?: string;
  summary?: string;
  severity?: string;
  [key: string]: unknown;
};

/** Payload for `feedback.triaged`. */
export type FeedbackTriagedData = {
  feedbackId: string;
  disposition: string;
  appId?: string;
  triagedBy?: string;
  [key: string]: unknown;
};

export type DistributionEventDataMap = {
  "release.published": ReleasePublishedData;
  "release.rollout.started": RolloutData;
  "release.rollout.completed": RolloutData;
  "release.rollout.failed": RolloutData;
  "app.installed": AppInstalledData;
  "announcement.sent": AnnouncementSentData;
  "feedback.created": FeedbackCreatedData;
  "feedback.triaged": FeedbackTriagedData;
};

// ---------------------------------------------------------------------------
// Structural validators (dependency-free)
// ---------------------------------------------------------------------------

const PUBLISH_PATHS: readonly string[] = ["skill", "ci", "backfilled"];
const ROLLOUT_ACTIONS: readonly string[] = ["install", "update", "rollback", "freeze-blocked"];

function requireString(data: EventData, key: string, issues: EventValidationIssue[]): void {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path: key, message: "must be a non-empty string" });
  }
}

function optionalString(data: EventData, key: string, issues: EventValidationIssue[]): void {
  const value = data[key];
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    issues.push({ path: key, message: "must be a non-empty string when present" });
  }
}

function optionalEnum(data: EventData, key: string, allowed: readonly string[], issues: EventValidationIssue[]): void {
  const value = data[key];
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    issues.push({ path: key, message: `must be one of: ${allowed.join(", ")}` });
  }
}

function optionalStringArray(data: EventData, key: string, issues: EventValidationIssue[]): void {
  const value = data[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    issues.push({ path: key, message: "must be an array of non-empty strings when present" });
  }
}

function toResult(issues: EventValidationIssue[]): EventValidationResult {
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export const validateReleasePublishedData: EventDataValidator = (data) => {
  const issues: EventValidationIssue[] = [];
  requireString(data, "appId", issues);
  requireString(data, "package", issues);
  requireString(data, "version", issues);
  optionalString(data, "gitSha", issues);
  optionalString(data, "publishedAt", issues);
  optionalEnum(data, "publishPath", PUBLISH_PATHS, issues);
  return toResult(issues);
};

export const validateRolloutData: EventDataValidator = (data, event) => {
  const issues: EventValidationIssue[] = [];
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

export const validateAppInstalledData: EventDataValidator = (data) => {
  const issues: EventValidationIssue[] = [];
  requireString(data, "appId", issues);
  requireString(data, "package", issues);
  requireString(data, "version", issues);
  requireString(data, "machine", issues);
  return toResult(issues);
};

export const validateAnnouncementSentData: EventDataValidator = (data) => {
  const issues: EventValidationIssue[] = [];
  requireString(data, "campaignId", issues);
  optionalString(data, "appId", issues);
  optionalString(data, "audienceId", issues);
  optionalString(data, "releaseId", issues);
  optionalStringArray(data, "channels", issues);
  return toResult(issues);
};

export const validateFeedbackCreatedData: EventDataValidator = (data) => {
  const issues: EventValidationIssue[] = [];
  requireString(data, "feedbackId", issues);
  optionalString(data, "appId", issues);
  optionalString(data, "source", issues);
  optionalString(data, "summary", issues);
  return toResult(issues);
};

export const validateFeedbackTriagedData: EventDataValidator = (data) => {
  const issues: EventValidationIssue[] = [];
  requireString(data, "feedbackId", issues);
  requireString(data, "disposition", issues);
  optionalString(data, "appId", issues);
  optionalString(data, "triagedBy", issues);
  return toResult(issues);
};

/** Fresh definitions for every distribution event type. */
export function createDistributionEventDefinitions(): EventTypeDefinition[] {
  const bind = (type: DistributionEventType, validate: EventDataValidator, description: string): EventTypeDefinition => ({
    type,
    contractSchemaId: DISTRIBUTION_EVENT_CONTRACT_SCHEMAS[type],
    description,
    validate,
  });
  return [
    bind("release.published", validateReleasePublishedData, "A package version was published"),
    bind("release.rollout.started", validateRolloutData, "A rollout of a release to a machine started"),
    bind("release.rollout.completed", validateRolloutData, "A rollout of a release to a machine completed"),
    bind("release.rollout.failed", validateRolloutData, "A rollout of a release to a machine failed"),
    bind("app.installed", validateAppInstalledData, "An app was installed on a machine"),
    bind("announcement.sent", validateAnnouncementSentData, "An announcement campaign was sent"),
    bind("feedback.created", validateFeedbackCreatedData, "User or agent feedback was captured"),
    bind("feedback.triaged", validateFeedbackTriagedData, "Captured feedback was triaged"),
  ];
}

/**
 * Register the distribution event types on a catalog (the shared default
 * catalog when omitted). Opt-in: nothing is registered until this is called.
 */
export function registerDistributionEventTypes(catalog: EventTypeCatalog = defaultEventTypeCatalog): EventTypeCatalog {
  for (const definition of createDistributionEventDefinitions()) {
    catalog.register(definition);
  }
  return catalog;
}
