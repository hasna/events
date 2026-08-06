import type { ChannelConfig, DeliveryResult, EmitOptions, EmitResult, EventEnvelope, EventFilter, EventPage, EventPageOptions, EventInput, EventRedactor, ReplayOptions, ReplayResult } from "./types.js";
import { type EventsStore } from "./storage.js";
import { type TransportDispatchOptions } from "./transports.js";
import { type EventTypeCatalog } from "./catalog.js";
export * from "./types.js";
export * from "./storage.js";
export * from "./filter.js";
export * from "./signing.js";
export * from "./transports.js";
export * from "./catalog.js";
export * from "./app-event.js";
export interface EventsClientOptions extends TransportDispatchOptions {
    store?: EventsStore;
    dataDir?: string;
    redactors?: EventRedactor[];
    /**
     * Event type catalog used by the opt-in emit-time validator hook. Defaults
     * to the shared `defaultEventTypeCatalog`.
     */
    catalog?: EventTypeCatalog;
    /**
     * Opt-in: when true, emitted events whose `type` is registered in the
     * catalog are validated and rejected (with `EventValidationError`) before
     * they are stored or delivered. Unregistered/free-form types always pass.
     * Defaults to false, so existing emitters are untouched.
     */
    validateCatalogTypes?: boolean;
}
export interface ChannelMatchResult {
    channelId: string;
    matched: boolean;
    event: EventEnvelope;
    filters?: EventFilter[];
    reason?: string;
}
export interface TestChannelOptions {
    honorFilters?: boolean;
}
export declare function createEvent<TData extends Record<string, unknown>>(input: EventInput<TData>): EventEnvelope<TData>;
export declare class EventsClient {
    private store;
    private redactors;
    private transportOptions;
    private catalog;
    private validateCatalogTypes;
    constructor(options?: EventsClientOptions);
    addChannel(input: Omit<ChannelConfig, "createdAt" | "updatedAt"> & Partial<Pick<ChannelConfig, "createdAt" | "updatedAt">>): Promise<ChannelConfig>;
    listChannels(): Promise<ChannelConfig[]>;
    removeChannel(id: string): Promise<boolean>;
    emit<TData extends Record<string, unknown>>(input: EventInput<TData>, options?: EmitOptions): Promise<EmitResult<TData>>;
    listEvents(options?: EventPageOptions): Promise<EventEnvelope[]>;
    listEventsPage(options?: EventPageOptions): Promise<EventPage>;
    listDeliveries(): Promise<DeliveryResult[]>;
    deliver(event: EventEnvelope): Promise<DeliveryResult[]>;
    matchChannel(id: string, input?: Partial<EventInput>): Promise<ChannelMatchResult>;
    testChannel(id: string, input?: Partial<EventInput>, options?: TestChannelOptions): Promise<DeliveryResult>;
    replay(options?: ReplayOptions): Promise<ReplayResult>;
    private appendEvent;
    private applyRedaction;
    private deliverWithRetry;
}
export declare function redactPaths<T extends EventEnvelope>(event: T, paths: string[], replacement?: string): T;
export declare function sanitizeChannelForOutput(channel: ChannelConfig): ChannelConfig;
export declare function sanitizeChannelsForOutput(channels: ChannelConfig[]): ChannelConfig[];
export declare function redactSensitiveKeys<T extends EventEnvelope>(event: T, replacement?: string): T;
