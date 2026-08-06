import type { EventData, EventEnvelope, EventInput, EventSeverity } from "./types.js";
/** Stable wire-profile identifier for cross-app events. */
export declare const APP_EVENT_V1_SCHEMA_VERSION: "hasna.app_event.v1";
export declare const APP_EVENT_V1_METADATA_KEY: "app_event";
export declare const APP_EVENT_V1_MAX_SUMMARY_LENGTH = 512;
export declare const APP_EVENT_V1_MAX_DATA_BYTES: number;
export declare const APP_EVENT_V1_MAX_REFS = 32;
export declare const APP_EVENT_V1_MAX_TARGETS = 16;
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
export type AppEventValidationResult = {
    ok: true;
} | {
    ok: false;
    issues: AppEventValidationIssue[];
};
export declare class AppEventValidationError extends Error {
    readonly issues: AppEventValidationIssue[];
    constructor(issues: AppEventValidationIssue[]);
}
export declare class AppEventReplaySafetyError extends Error {
    readonly eventId: string;
    constructor(eventId: string);
}
export declare function validateAppEventV1(value: unknown): AppEventValidationResult;
export declare function assertAppEventV1<TData extends EventData = EventData>(value: unknown): asserts value is AppEventV1<TData>;
export declare function assertAppEventV1ReplaySafe(event: AppEventV1): void;
export declare function appEventV1ReplayIdentity(event: AppEventV1): {
    eventId: string;
    dedupeKey: string;
};
/** Map the profile onto the existing @hasna/events envelope without another transport or store. */
export declare function appEventV1ToEventInput<TData extends EventData>(event: AppEventV1<TData>): EventInput<TData>;
/** Reconstruct a profile from an @hasna/events envelope produced by the adapter. */
export declare function appEventV1FromEventEnvelope<TData extends EventData = EventData>(envelope: EventEnvelope<TData>): AppEventV1<TData>;
