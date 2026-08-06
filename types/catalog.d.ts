import type { EventData, EventEnvelope } from "./types.js";
export interface EventValidationIssue {
    path: string;
    message: string;
}
export type EventValidationResult = {
    ok: true;
} | {
    ok: false;
    issues: EventValidationIssue[];
};
export type EventDataValidator = (data: EventData, event: EventEnvelope) => EventValidationResult;
export interface EventTypeDefinition {
    /** Envelope `type` string this definition binds, e.g. `release.published`. */
    type: string;
    /** `@hasna/contracts` schema id the payload mirrors, e.g. `hasna.release.v1`. */
    contractSchemaId?: string;
    description?: string;
    validate: EventDataValidator;
}
export declare class EventValidationError extends Error {
    readonly eventType: string;
    readonly issues: EventValidationIssue[];
    constructor(eventType: string, issues: EventValidationIssue[]);
}
export declare class EventTypeCatalog {
    private definitions;
    register(definition: EventTypeDefinition): this;
    unregister(type: string): boolean;
    has(type: string): boolean;
    get(type: string): EventTypeDefinition | undefined;
    list(): EventTypeDefinition[];
    /**
     * Validate an event against its registered definition. Events whose type is
     * NOT registered always pass: free-form types stay untouched.
     */
    validateEvent(event: EventEnvelope): EventValidationResult;
    /** Like {@link validateEvent} but throws {@link EventValidationError}. */
    assertEventValid(event: EventEnvelope): void;
}
/** Shared default catalog used by `EventsClient` when none is provided. */
export declare const defaultEventTypeCatalog: EventTypeCatalog;
export declare const DISTRIBUTION_EVENT_TYPES: {
    readonly releasePublished: "release.published";
    readonly rolloutStarted: "release.rollout.started";
    readonly rolloutCompleted: "release.rollout.completed";
    readonly rolloutFailed: "release.rollout.failed";
    readonly appInstalled: "app.installed";
    readonly announcementSent: "announcement.sent";
    readonly feedbackCreated: "feedback.created";
    readonly feedbackTriaged: "feedback.triaged";
};
export type DistributionEventType = (typeof DISTRIBUTION_EVENT_TYPES)[keyof typeof DISTRIBUTION_EVENT_TYPES];
/** Contracts schema id each distribution event payload mirrors. */
export declare const DISTRIBUTION_EVENT_CONTRACT_SCHEMAS: Record<DistributionEventType, string>;
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
export declare const validateReleasePublishedData: EventDataValidator;
export declare const validateRolloutData: EventDataValidator;
export declare const validateAppInstalledData: EventDataValidator;
export declare const validateAnnouncementSentData: EventDataValidator;
export declare const validateFeedbackCreatedData: EventDataValidator;
export declare const validateFeedbackTriagedData: EventDataValidator;
/** Fresh definitions for every distribution event type. */
export declare function createDistributionEventDefinitions(): EventTypeDefinition[];
/**
 * Register the distribution event types on a catalog (the shared default
 * catalog when omitted). Opt-in: nothing is registered until this is called.
 */
export declare function registerDistributionEventTypes(catalog?: EventTypeCatalog): EventTypeCatalog;
