import { DurableEventsBroker, type DurableDrainResult, type DurableSpoolImportResult } from "./durable.js";
export interface DurableWorkerOptions {
    broker: DurableEventsBroker;
    signal: AbortSignal;
    workerId?: string;
    limit?: number;
    leaseMs?: number;
    debounceMs?: number;
    reconcileMs?: number;
    watchRestartMs?: number;
    onCycle?: (cycle: DurableWorkerCycle) => void | Promise<void>;
}
export interface DurableWorkerCycle {
    imported: DurableSpoolImportResult;
    drained: DurableDrainResult;
}
export interface DurableWorkerResult {
    workerId: string;
    cycles: number;
    imported: number;
    deduped: number;
    delivered: number;
    retried: number;
    dead: number;
}
export declare function runDurableWorker(options: DurableWorkerOptions): Promise<DurableWorkerResult>;
