// @bun
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
export {
  validateRolloutData,
  validateReleasePublishedData,
  validateFeedbackTriagedData,
  validateFeedbackCreatedData,
  validateAppInstalledData,
  validateAnnouncementSentData,
  registerDistributionEventTypes,
  defaultEventTypeCatalog,
  createDistributionEventDefinitions,
  EventValidationError,
  EventTypeCatalog,
  DISTRIBUTION_EVENT_TYPES,
  DISTRIBUTION_EVENT_CONTRACT_SCHEMAS
};
