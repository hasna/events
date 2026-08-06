import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableEventSpool } from "./durable-spool.js";
import { DurableEventsBroker } from "./durable.js";
import { runDurableWorker } from "./durable-worker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runDurableWorker", () => {
  test("watches the spool and wakes from persisted retry time without polling notes", async () => {
    const dataDir = await temporaryDataDir();
    let attempts = 0;
    const broker = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("retry", { status: 503 })
          : new Response("queued", { status: 202 });
      },
    });
    broker.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
      retry: { maxAttempts: 3, backoffMs: 20, multiplier: 1 },
    });

    const controller = new AbortController();
    const worker = runDurableWorker({
      broker,
      signal: controller.signal,
      workerId: "worker-test",
      debounceMs: 5,
      reconcileMs: 60_000,
      watchRestartMs: 10,
    });
    const spool = new DurableEventSpool({ dataDir });
    await spool.enqueue({
      id: "notes:note:worker:created",
      source: "notes",
      type: "note.created",
      time: "2020-01-01T00:00:00.000Z",
      dedupeKey: "notes:note:worker:created",
      schemaVersion: "notes.v1",
      data: { noteId: "worker" },
      metadata: {},
    });

    await waitFor(() => attempts === 2, 5_000);
    controller.abort();
    const result = await worker;
    expect(result).toMatchObject({
      workerId: "worker-test",
      imported: 1,
      delivered: 1,
      retried: 1,
      dead: 0,
    });
    expect(broker.status().counts).toMatchObject({ pending: 0, leased: 0, delivered: 1 });
    broker.close();
  });

  test("chunks retry timers beyond the runtime timeout ceiling instead of spinning", async () => {
    const dataDir = await temporaryDataDir();
    let attempts = 0;
    let cycles = 0;
    const broker = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => {
        attempts += 1;
        return new Response("retry", { status: 503 });
      },
    });
    broker.addChannel({
      id: "long-retry",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.invalid", secretRef: "env:SAFE_REFERENCE" },
      retry: { maxAttempts: 2, backoffMs: 2_147_483_648, multiplier: 1 },
    });
    broker.enqueue({ id: "long-retry-event", source: "notes", type: "note.created" });

    const controller = new AbortController();
    const worker = runDurableWorker({
      broker,
      signal: controller.signal,
      reconcileMs: 60_000,
      onCycle: () => { cycles += 1; },
    });
    await waitFor(() => cycles === 1, 5_000);
    await Bun.sleep(25);
    controller.abort();
    const result = await worker;
    expect(attempts).toBe(1);
    expect(cycles).toBe(1);
    expect(result).toMatchObject({ retried: 1, delivered: 0, lost: 0 });
    broker.close();
  });
});

async function temporaryDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hasna-events-worker-test-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable worker delivery");
    await Bun.sleep(10);
  }
}
