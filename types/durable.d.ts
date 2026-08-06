import { type TransportDispatchOptions } from "./transports.js";
import type { ChannelConfig, DeliveryResult, EventEnvelope, EventInput } from "./types.js";
export interface DurableEventsBrokerOptions extends TransportDispatchOptions {
    dataDir: string;
    databaseName?: string;
    now?: () => Date;
}
export interface DurableEnqueueOptions {
    dedupe?: boolean;
}
export interface DurableEnqueueResult<TData extends Record<string, unknown> = Record<string, unknown>> {
    event: EventEnvelope<TData>;
    deduped: boolean;
    queued: number;
}
export interface DurableDrainOptions {
    workerId?: string;
    limit?: number;
    leaseMs?: number;
}
export interface DurableDrainResult {
    workerId: string;
    claimed: number;
    delivered: number;
    retried: number;
    dead: number;
    deliveries: DeliveryResult[];
}
export interface DurableSpoolImportOptions {
    limit?: number;
}
export interface DurableSpoolImportResult {
    scanned: number;
    imported: number;
    deduped: number;
    queued: number;
}
export interface DurableRetryDeadOptions {
    eventId?: string;
    channelId?: string;
    limit?: number;
}
export interface DurableRetryDeadResult {
    matched: number;
    requeued: number;
}
export type DurableOutboxStatus = "pending" | "leased" | "delivered" | "dead";
export interface DurableEventsStatus {
    service: "events";
    storage: "local-sqlite";
    schemaVersion: number;
    databasePath: string;
    counts: {
        channels: number;
        enabledChannels: number;
        events: number;
        pending: number;
        leased: number;
        delivered: number;
        dead: number;
    };
    safety: {
        statusOmitsEventPayloads: true;
        databasePersistsEventEnvelopes: true;
        includesResolvedSecrets: false;
        inlineWebhookSecretsAllowed: false;
    };
}
export interface DurableDeliveryJob {
    id: string;
    event: EventEnvelope;
    channel: ChannelConfig;
    attempt: number;
    workerId: string;
}
export interface DurableSettleResult {
    status: "delivered" | "retry" | "dead";
    delivery?: DeliveryResult;
}
export declare function defaultWebhookSecretResolver(reference: string): string | undefined;
export declare class DurableEventsBroker {
    readonly dataDir: string;
    readonly databasePath: string;
    private readonly db;
    private readonly now;
    private readonly transportOptions;
    constructor(options: DurableEventsBrokerOptions);
    close(): void;
    addChannel(input: Omit<ChannelConfig, "createdAt" | "updatedAt"> & Partial<Pick<ChannelConfig, "createdAt" | "updatedAt">>): ChannelConfig;
    listChannels(): ChannelConfig[];
    enqueue<TData extends Record<string, unknown>>(input: EventInput<TData>, options?: DurableEnqueueOptions): DurableEnqueueResult<TData>;
    drain(options?: DurableDrainOptions): Promise<DurableDrainResult>;
    importSpool(options?: DurableSpoolImportOptions): DurableSpoolImportResult;
    retryDead(options?: DurableRetryDeadOptions): DurableRetryDeadResult;
    status(): DurableEventsStatus;
    nextWakeAt(): number | undefined;
    private claim;
    private settle;
    private completeOutbox;
    private findEvent;
    private queueMatchingChannels;
    private count;
    private immediate;
    private ensureSchema;
    private secureDatabaseFiles;
}
