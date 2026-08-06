import { chmodSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableEventSpool } from "./durable-spool.js";
import { DurableEventsBroker, type DurableDrainResult, type DurableSpoolImportResult } from "./durable.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  lost: number;
}

export async function runDurableWorker(options: DurableWorkerOptions): Promise<DurableWorkerResult> {
  const workerId = options.workerId ?? randomUUID();
  const limit = positiveInteger(options.limit, 100, "limit");
  const leaseMs = positiveInteger(options.leaseMs, 60_000, "leaseMs");
  const debounceMs = nonNegativeInteger(options.debounceMs, 50, "debounceMs");
  const reconcileMs = positiveInteger(options.reconcileMs, 30_000, "reconcileMs");
  const watchRestartMs = positiveInteger(options.watchRestartMs, 1_000, "watchRestartMs");
  const spool = new DurableEventSpool({ dataDir: options.broker.dataDir });
  const inboxDir = spool.inboxDir;
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  chmodSync(join(options.broker.dataDir, "spool"), 0o700);
  chmodSync(inboxDir, 0o700);

  const totals: DurableWorkerResult = {
    workerId,
    cycles: 0,
    imported: 0,
    deduped: 0,
    delivered: 0,
    retried: 0,
    dead: 0,
    lost: 0,
  };

  return new Promise<DurableWorkerResult>((resolve, reject) => {
    let watcher: FSWatcher | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let reconcileTimer: ReturnType<typeof setInterval> | undefined;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let rerun = false;
    let stopped = false;

    const clearRetryTimer = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      if (debounceTimer) clearTimeout(debounceTimer);
      clearRetryTimer();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (restartTimer) clearTimeout(restartTimer);
      options.signal.removeEventListener("abort", stop);
      if (!running) resolve(totals);
    };

    const scheduleRetryWake = () => {
      clearRetryTimer();
      if (stopped) return;
      const nextWakeAt = options.broker.nextWakeAt();
      if (nextWakeAt === undefined) return;
      const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextWakeAt - Date.now()));
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void runCycle();
      }, delay);
    };

    const runCycle = async () => {
      if (stopped) return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      clearRetryTimer();
      try {
        await spool.recover();
        const imported = options.broker.importSpool({ limit });
        const drained = await options.broker.drain({ workerId, limit, leaseMs });
        const cycle = { imported, drained };
        totals.cycles += 1;
        totals.imported += imported.imported;
        totals.deduped += imported.deduped;
        totals.delivered += drained.delivered;
        totals.retried += drained.retried;
        totals.dead += drained.dead;
        totals.lost += drained.lost;
        await options.onCycle?.(cycle);
        if (imported.scanned >= limit || drained.claimed >= limit) rerun = true;
      } catch (error) {
        reject(error);
        stop();
        return;
      } finally {
        running = false;
      }
      if (stopped) {
        resolve(totals);
      } else if (rerun) {
        rerun = false;
        queueMicrotask(() => { void runCycle(); });
      } else {
        scheduleRetryWake();
      }
    };

    const scheduleDebouncedCycle = () => {
      if (stopped) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void runCycle();
      }, debounceMs);
    };

    const startWatcher = () => {
      if (stopped) return;
      watcher?.close();
      try {
        watcher = watch(inboxDir, (_eventType, filename) => {
          if (!filename || filename.toString().endsWith(".json")) scheduleDebouncedCycle();
        });
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
          scheduleDebouncedCycle();
          if (!stopped) restartTimer = setTimeout(startWatcher, watchRestartMs);
        });
      } catch {
        scheduleDebouncedCycle();
        if (!stopped) restartTimer = setTimeout(startWatcher, watchRestartMs);
      }
    };

    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) {
      stop();
      return;
    }
    startWatcher();
    reconcileTimer = setInterval(() => { void runCycle(); }, reconcileMs);
    void runCycle();
  });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${name} must be a non-negative integer`);
  return resolved;
}
