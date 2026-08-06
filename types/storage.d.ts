import type { ChannelConfig, DeliveryResult, EventAppendOptions, EventAppendResult, EventEnvelope, EventPage, EventPageOptions, EventsStatus, EventsStoreRuntime, StoredEventsData } from "./types.js";
export declare const HASNA_EVENTS_DIR_ENV = "HASNA_EVENTS_DIR";
export declare const HASNA_EVENTS_HOME_ENV = "HASNA_EVENTS_HOME";
export declare const LOCAL_JSON_EVENT_CURSOR_PREFIX = "local-json-v1:";
export declare const DEFAULT_EVENT_PAGE_LIMIT = 100;
export declare const MAX_EVENT_PAGE_LIMIT = 1000;
export declare function getEventsDataDir(override?: string): string;
export declare function getActiveEventsDirEnv(): EventsStatus["env"]["active"];
export interface EventsStore {
    dataDir: string;
    runtime?: EventsStoreRuntime;
    init(): Promise<void>;
    addChannel(channel: ChannelConfig): Promise<ChannelConfig>;
    listChannels(): Promise<ChannelConfig[]>;
    getChannel(id: string): Promise<ChannelConfig | undefined>;
    removeChannel(id: string): Promise<boolean>;
    appendEvent(event: EventEnvelope): Promise<EventEnvelope>;
    appendEventOnce?(event: EventEnvelope, options?: EventAppendOptions): Promise<EventAppendResult>;
    listEvents(options?: EventPageOptions): Promise<EventEnvelope[]>;
    listEventsPage?(options?: EventPageOptions): Promise<EventPage>;
    findEventByIdentity(identity: {
        id?: string;
        dedupeKey?: string;
    }): Promise<EventEnvelope | undefined>;
    appendDelivery(result: DeliveryResult): Promise<DeliveryResult>;
    listDeliveries(): Promise<DeliveryResult[]>;
}
export declare class JsonEventsStore implements EventsStore {
    dataDir: string;
    runtime: EventsStoreRuntime;
    private channelsPath;
    private eventsPath;
    private deliveriesPath;
    constructor(dataDir?: string);
    init(): Promise<void>;
    addChannel(channel: ChannelConfig): Promise<ChannelConfig>;
    listChannels(): Promise<ChannelConfig[]>;
    getChannel(id: string): Promise<ChannelConfig | undefined>;
    removeChannel(id: string): Promise<boolean>;
    appendEvent(event: EventEnvelope): Promise<EventEnvelope>;
    appendEventOnce(event: EventEnvelope, options?: EventAppendOptions): Promise<EventAppendResult>;
    listEvents(options?: EventPageOptions): Promise<EventEnvelope[]>;
    listEventsPage(options?: EventPageOptions): Promise<EventPage>;
    findEventByIdentity(identity: {
        id?: string;
        dedupeKey?: string;
    }): Promise<EventEnvelope | undefined>;
    appendDelivery(result: DeliveryResult): Promise<DeliveryResult>;
    listDeliveries(): Promise<DeliveryResult[]>;
    exportData(): Promise<StoredEventsData>;
    private ensureArrayFile;
    private readJson;
    private writeJson;
}
export declare function localJsonRuntime(dataDir?: string): EventsStoreRuntime;
export declare function encodeLocalJsonEventCursor(offset: number, options?: EventPageOptions): string;
export declare function decodeLocalJsonEventCursor(cursor: string | undefined, options?: EventPageOptions): number;
export declare function normalizeEventPageLimit(limit: number | undefined): number;
export declare function getEventsStatus(dataDir?: string): Promise<EventsStatus>;
