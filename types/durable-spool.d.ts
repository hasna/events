import type { EventEnvelope, EventInput } from "./types.js";
export interface DurableEventSpoolOptions {
    dataDir: string;
}
export interface DurableSpoolEnqueueResult<TData extends Record<string, unknown> = Record<string, unknown>> {
    event: EventEnvelope<TData>;
    stored: boolean;
    deduped: boolean;
}
export interface DurableSpoolRecoveryOptions {
    olderThanMs?: number;
}
export interface DurableSpoolRecoveryResult {
    recovered: number;
    deduped: number;
    cleaned: number;
}
export declare class DurableEventSpool {
    readonly dataDir: string;
    readonly inboxDir: string;
    constructor(options: DurableEventSpoolOptions);
    enqueue<TData extends Record<string, unknown>>(input: EventInput<TData>): Promise<DurableSpoolEnqueueResult<TData>>;
    recover(options?: DurableSpoolRecoveryOptions): Promise<DurableSpoolRecoveryResult>;
    close(): Promise<void>;
    private pathFor;
    private assertSameIdentity;
    private ensureInbox;
    private syncInbox;
    private syncDirectory;
}
