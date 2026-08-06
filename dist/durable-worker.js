// @bun
// src/durable-worker.ts
import { chmodSync, mkdirSync, watch } from "fs";
import { randomUUID as randomUUID2 } from "crypto";
import { join as join2 } from "path";

// src/durable-spool.ts
import { createHash, randomUUID } from "crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink
} from "fs/promises";
import { join } from "path";

class DurableEventSpool {
  dataDir;
  inboxDir;
  constructor(options) {
    if (!options.dataDir)
      throw new Error("DurableEventSpool requires dataDir");
    this.dataDir = options.dataDir;
    this.inboxDir = join(options.dataDir, "spool", "inbox");
  }
  async enqueue(input) {
    const event = createSpoolEvent(input);
    await this.ensureInbox();
    const finalPath = this.pathFor(event);
    const tempPath = join(this.inboxDir, `.tmp-${process.pid}-${randomUUID()}`);
    const handle = await open(tempPath, "wx", 384);
    try {
      await handle.writeFile(`${JSON.stringify(event)}
`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    let stored = false;
    try {
      await link(tempPath, finalPath);
      stored = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        await unlink(tempPath).catch(() => {
          return;
        });
        throw error;
      }
      await this.assertSameIdentity(finalPath, event);
    }
    await unlink(tempPath);
    await this.syncInbox();
    return { event, stored, deduped: !stored };
  }
  async recover(options = {}) {
    await this.ensureInbox();
    const olderThanMs = Math.max(0, options.olderThanMs ?? 60000);
    const threshold = Date.now() - olderThanMs;
    const result = { recovered: 0, deduped: 0, cleaned: 0 };
    const names = (await readdir(this.inboxDir)).filter((name) => name.startsWith(".tmp-")).sort();
    for (const name of names) {
      const tempPath = join(this.inboxDir, name);
      const details = await stat(tempPath).catch(() => {
        return;
      });
      if (!details || details.mtimeMs > threshold)
        continue;
      let event;
      try {
        event = parseEnvelope(await readFile(tempPath, "utf8"));
      } catch {
        await unlink(tempPath).catch(() => {
          return;
        });
        result.cleaned += 1;
        continue;
      }
      const finalPath = this.pathFor(event);
      try {
        await link(tempPath, finalPath);
        result.recovered += 1;
      } catch (error) {
        if (!isNodeError(error, "EEXIST"))
          throw error;
        await this.assertSameIdentity(finalPath, event);
        result.deduped += 1;
      }
      await unlink(tempPath).catch(() => {
        return;
      });
    }
    if (result.recovered || result.deduped || result.cleaned)
      await this.syncInbox();
    return result;
  }
  async close() {}
  pathFor(event) {
    const identity = event.dedupeKey ?? event.id;
    const digest = createHash("sha256").update(identity, "utf8").digest("hex");
    return join(this.inboxDir, `${digest}.json`);
  }
  async assertSameIdentity(path, event) {
    const existing = parseEnvelope(await readFile(path, "utf8"));
    const matches = existing.id === event.id || event.dedupeKey !== undefined && existing.dedupeKey === event.dedupeKey;
    if (!matches)
      throw new Error("Durable spool identity collision");
  }
  async ensureInbox() {
    const spoolDir = join(this.dataDir, "spool");
    await mkdir(this.inboxDir, { recursive: true, mode: 448 });
    await chmod(this.dataDir, 448);
    await chmod(spoolDir, 448);
    await chmod(this.inboxDir, 448);
    await this.syncDirectory(this.dataDir);
    await this.syncDirectory(spoolDir);
  }
  async syncInbox() {
    await this.syncDirectory(this.inboxDir);
  }
  async syncDirectory(path) {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
function createSpoolEvent(input) {
  return {
    id: input.id ?? randomUUID(),
    source: input.source,
    type: input.type,
    time: input.time instanceof Date ? input.time.toISOString() : input.time ?? new Date().toISOString(),
    subject: input.subject,
    severity: input.severity ?? "info",
    data: input.data ?? {},
    message: input.message,
    dedupeKey: input.dedupeKey,
    schemaVersion: input.schemaVersion ?? "1.0",
    metadata: input.metadata ?? {}
  };
}
function parseEnvelope(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("Invalid durable event spool record");
  for (const field of ["id", "source", "type", "time", "schemaVersion"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error("Invalid durable event spool record");
    }
  }
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    throw new Error("Invalid durable event spool record");
  }
  if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) {
    throw new Error("Invalid durable event spool record");
  }
  return value;
}
function isNodeError(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

// src/durable-worker.ts
async function runDurableWorker(options) {
  const workerId = options.workerId ?? randomUUID2();
  const limit = positiveInteger(options.limit, 100, "limit");
  const leaseMs = positiveInteger(options.leaseMs, 60000, "leaseMs");
  const debounceMs = nonNegativeInteger(options.debounceMs, 50, "debounceMs");
  const reconcileMs = positiveInteger(options.reconcileMs, 30000, "reconcileMs");
  const watchRestartMs = positiveInteger(options.watchRestartMs, 1000, "watchRestartMs");
  const spool = new DurableEventSpool({ dataDir: options.broker.dataDir });
  const inboxDir = spool.inboxDir;
  mkdirSync(inboxDir, { recursive: true, mode: 448 });
  chmodSync(join2(options.broker.dataDir, "spool"), 448);
  chmodSync(inboxDir, 448);
  const totals = {
    workerId,
    cycles: 0,
    imported: 0,
    deduped: 0,
    delivered: 0,
    retried: 0,
    dead: 0
  };
  return new Promise((resolve, reject) => {
    let watcher;
    let debounceTimer;
    let retryTimer;
    let reconcileTimer;
    let restartTimer;
    let running = false;
    let rerun = false;
    let stopped = false;
    const clearRetryTimer = () => {
      if (retryTimer)
        clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const stop = () => {
      if (stopped)
        return;
      stopped = true;
      watcher?.close();
      if (debounceTimer)
        clearTimeout(debounceTimer);
      clearRetryTimer();
      if (reconcileTimer)
        clearInterval(reconcileTimer);
      if (restartTimer)
        clearTimeout(restartTimer);
      options.signal.removeEventListener("abort", stop);
      if (!running)
        resolve(totals);
    };
    const scheduleRetryWake = () => {
      clearRetryTimer();
      if (stopped)
        return;
      const nextWakeAt = options.broker.nextWakeAt();
      if (nextWakeAt === undefined)
        return;
      const delay = Math.max(0, nextWakeAt - Date.now());
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        runCycle();
      }, delay);
    };
    const runCycle = async () => {
      if (stopped)
        return;
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
        await options.onCycle?.(cycle);
        if (imported.scanned >= limit || drained.claimed >= limit)
          rerun = true;
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
        queueMicrotask(() => {
          runCycle();
        });
      } else {
        scheduleRetryWake();
      }
    };
    const scheduleDebouncedCycle = () => {
      if (stopped)
        return;
      if (debounceTimer)
        clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        runCycle();
      }, debounceMs);
    };
    const startWatcher = () => {
      if (stopped)
        return;
      watcher?.close();
      try {
        watcher = watch(inboxDir, (_eventType, filename) => {
          if (!filename || filename.toString().endsWith(".json"))
            scheduleDebouncedCycle();
        });
        watcher.on("error", () => {
          watcher?.close();
          watcher = undefined;
          scheduleDebouncedCycle();
          if (!stopped)
            restartTimer = setTimeout(startWatcher, watchRestartMs);
        });
      } catch {
        scheduleDebouncedCycle();
        if (!stopped)
          restartTimer = setTimeout(startWatcher, watchRestartMs);
      }
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) {
      stop();
      return;
    }
    startWatcher();
    reconcileTimer = setInterval(() => {
      runCycle();
    }, reconcileMs);
    runCycle();
  });
}
function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error(`${name} must be a positive integer`);
  return resolved;
}
function nonNegativeInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return resolved;
}
export {
  runDurableWorker
};
