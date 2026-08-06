import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableEventSpool } from "./durable-spool.js";
import { DurableEventsBroker } from "./durable.js";
import { verifyWebhookSignature } from "./signing.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DurableEventsBroker", () => {
  test("atomically dedupes across connections and applies exact enabled filters", async () => {
    const dataDir = await temporaryDataDir();
    const first = new DurableEventsBroker({ dataDir });
    first.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid/notes", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
    });
    first.addChannel({
      id: "notes-disabled",
      enabled: false,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid/disabled", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
    });
    const input = {
      id: "notes:note:abc:created",
      source: "notes",
      type: "note.created",
      time: "2026-08-06T11:00:00.000Z",
      subject: "note:abc",
      dedupeKey: "notes:note:abc:created",
      schemaVersion: "notes.v1",
      data: {
        noteId: "abc",
        createdAt: "2026-08-06T11:00:00.000Z",
        originMachine: "station03",
      },
      metadata: {},
    };
    const inserted = first.enqueue(input);
    expect(inserted).toEqual({ event: { ...input, severity: "info" }, deduped: false, queued: 1 });

    const second = new DurableEventsBroker({ dataDir });
    const duplicate = second.enqueue(input);
    expect(duplicate.deduped).toBe(true);
    expect(duplicate.queued).toBe(0);
    expect(second.enqueue({ ...input, id: "different", dedupeKey: "different", type: "note.updated" }).queued).toBe(0);
    expect(second.enqueue({ ...input, id: "different-source", dedupeKey: "different-source", source: "other" }).queued).toBe(0);
    second.addChannel({
      id: "notes-disabled",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid/disabled", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
    });
    expect(second.enqueue(input)).toMatchObject({ deduped: true, queued: 1 });
    expect(second.status().counts).toMatchObject({ channels: 2, enabledChannels: 2, events: 3, pending: 2 });
    second.close();
    first.close();
  });

  test("rejects persisted raw secrets", async () => {
    const broker = new DurableEventsBroker({ dataDir: await temporaryDataDir() });
    expect(() => broker.addChannel({
      id: "unsafe",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secret: "must-not-persist" },
    })).toThrow("reject inline webhook secrets");
    expect(() => broker.addChannel({
      id: "unsafe-command",
      enabled: true,
      transport: "command",
      command: {
        command: "echo",
        env: { PASSWORD: "credential-command-canary" },
      },
    })).toThrow("only webhook transport");
    expect(() => broker.addChannel({
      id: "userinfo",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://user:password@example.invalid", secretRef: "env:SAFE_REFERENCE" },
    })).toThrow("must not contain credentials");
    expect(() => broker.addChannel({
      id: "query-credential",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.invalid?api_key=credential-canary", secretRef: "env:SAFE_REFERENCE" },
    })).toThrow("credential query parameters");
    expect(() => broker.addChannel({
      id: "raw-reference",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.invalid", secretRef: "credential-canary-without-a-scheme" },
    })).toThrow("must be a runtime reference");
    for (const name of ["Authorization", "Cookie", "X-API-Key", "X-Auth-Token"]) {
      expect(() => broker.addChannel({
        id: `unsafe-${name}`,
        enabled: true,
        transport: "webhook",
        webhook: {
          url: "https://example.invalid",
          secretRef: "env:SAFE_REFERENCE",
          headers: { [name]: "credential-header-canary" },
        },
      })).toThrow("credential headers are not persisted");
    }
    broker.close();
  });

  test("does not persist arbitrary thrown transport errors", async () => {
    const dataDir = await temporaryDataDir();
    const broker = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => {
        throw new Error("credential-transport-error-canary");
      },
    });
    broker.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
      retry: { maxAttempts: 1 },
    });
    broker.enqueue({ id: "error-canary", source: "notes", type: "note.created", dedupeKey: "error-canary" });
    const result = await broker.drain();
    expect(result).toMatchObject({ dead: 1, delivered: 0 });
    expect(result.deliveries[0]?.attempts[0]?.error).toBe("Webhook delivery failed");
    expect(JSON.stringify(result)).not.toContain("credential-transport-error-canary");
    broker.close();

    const database = new Database(join(dataDir, "events.sqlite"), { readonly: true });
    const serialized = database.query(`
      SELECT config_json AS value FROM channels
      UNION ALL SELECT channel_json AS value FROM outbox
      UNION ALL SELECT result_json AS value FROM deliveries
    `).all().map((row) => String((row as { value: unknown }).value)).join("\n");
    database.close();
    expect(serialized).not.toContain("credential-transport-error-canary");
    expect(serialized).not.toContain("credential-command-canary");
  });

  test("persists retry state across restart and accepts only 2xx as delivery success", async () => {
    const dataDir = await temporaryDataDir();
    let clock = new Date("2026-08-06T12:00:00.000Z");
    const observedRequests: Array<{ headers: Headers; body: string }> = [];
    const first = new DurableEventsBroker({
      dataDir,
      now: () => clock,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async (_input, init) => {
        observedRequests.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response("receiver-echo-credential-canary", { status: 503 });
      },
    });
    first.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid/notes", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
      retry: { maxAttempts: 3, backoffMs: 100, multiplier: 2 },
    });
    first.enqueue({
      id: "event-1",
      source: "notes",
      type: "note.created",
      time: "2020-01-01T00:00:00.000Z",
      dedupeKey: "event-1",
    });
    const failed = await first.drain({ workerId: "worker-a" });
    expect(failed).toMatchObject({ claimed: 1, delivered: 0, retried: 1, dead: 0 });
    const firstTimestamp = observedRequests[0]?.headers.get("x-hasna-timestamp") ?? "";
    const firstSignature = observedRequests[0]?.headers.get("x-hasna-signature") ?? "";
    expect(firstTimestamp).toBe("2026-08-06T12:00:00.000Z");
    expect(JSON.parse(observedRequests[0]?.body ?? "{}").time).toBe("2020-01-01T00:00:00.000Z");
    expect(verifyWebhookSignature(
      "runtime-only-test-secret",
      firstTimestamp,
      observedRequests[0]?.body ?? "",
      firstSignature,
      { now: clock },
    )).toBe(true);
    expect(verifyWebhookSignature(
      "runtime-only-test-secret",
      firstTimestamp,
      observedRequests[0]?.body ?? "",
      firstSignature,
      { now: new Date(clock.getTime() + 6 * 60 * 1_000) },
    )).toBe(false);
    first.close();

    clock = new Date(clock.getTime() + 101);
    const second = new DurableEventsBroker({
      dataDir,
      now: () => clock,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async (_input, init) => {
        observedRequests.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response("receiver-echo-credential-canary", { status: 202 });
      },
    });
    const succeeded = await second.drain({ workerId: "worker-b" });
    expect(succeeded).toMatchObject({ claimed: 1, delivered: 1, retried: 0, dead: 0 });
    expect(second.status().counts).toMatchObject({ pending: 0, leased: 0, delivered: 1, dead: 0 });
    expect(observedRequests[1]?.headers.get("x-hasna-timestamp")).toBe("2026-08-06T12:00:00.101Z");
    expect(observedRequests[1]?.headers.get("x-hasna-timestamp")).not.toBe(firstTimestamp);
    const secondTimestamp = observedRequests[1]?.headers.get("x-hasna-timestamp") ?? "";
    const secondSignature = observedRequests[1]?.headers.get("x-hasna-signature") ?? "";
    expect(secondSignature).not.toBe(firstSignature);
    expect(verifyWebhookSignature(
      "runtime-only-test-secret",
      secondTimestamp,
      observedRequests[1]?.body ?? "",
      secondSignature,
      { now: clock },
    )).toBe(true);
    expect(JSON.stringify(succeeded)).not.toContain("receiver-echo-credential-canary");
    second.close();

    const database = new Database(join(dataDir, "events.sqlite"), { readonly: true });
    const serialized = database.query(`
      SELECT config_json AS value FROM channels
      UNION ALL SELECT channel_json AS value FROM outbox
      UNION ALL SELECT result_json AS value FROM deliveries
    `).all().map((row) => String((row as { value: unknown }).value)).join("\n");
    database.close();
    expect(serialized).not.toContain("runtime-only-test-secret");
    expect(serialized).not.toContain("receiver-echo-credential-canary");
    expect(serialized).toContain("env:HASNA_NOTES_WEBHOOK_SECRET");
  });

  test("imports Node spool records before unlink and converges after a duplicate import", async () => {
    const dataDir = await temporaryDataDir();
    const spool = new DurableEventSpool({ dataDir });
    const event = {
      id: "notes:note:spooled:created",
      source: "notes",
      type: "note.created",
      time: "2026-08-06T12:30:00.000Z",
      dedupeKey: "notes:note:spooled:created",
      schemaVersion: "notes.v1",
      data: { noteId: "spooled" },
      metadata: {},
    };
    await spool.enqueue(event);
    const broker = new DurableEventsBroker({ dataDir });
    broker.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
    });
    expect(broker.importSpool()).toEqual({ scanned: 1, imported: 1, deduped: 0, queued: 1 });
    expect((await readdir(spool.inboxDir)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    await spool.enqueue(event);
    expect(broker.importSpool()).toEqual({ scanned: 1, imported: 0, deduped: 1, queued: 0 });
    expect(broker.status().counts.events).toBe(1);
    broker.close();
  });

  test("explicitly requeues bounded dead jobs without creating a duplicate outbox identity", async () => {
    const dataDir = await temporaryDataDir();
    const first = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => new Response("not accepted", { status: 400 }),
    });
    first.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
      retry: { maxAttempts: 1 },
    });
    first.enqueue({ id: "dead-event", source: "notes", type: "note.created", dedupeKey: "dead-event" });
    expect(await first.drain()).toMatchObject({ dead: 1, delivered: 0 });
    expect(first.retryDead({ eventId: "other", limit: 1 })).toEqual({ matched: 0, requeued: 0 });
    expect(first.retryDead({ eventId: "dead-event", channelId: "notes-created", limit: 1 })).toEqual({ matched: 1, requeued: 1 });
    first.close();

    const second = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => new Response("queued", { status: 204 }),
    });
    expect(await second.drain()).toMatchObject({ claimed: 1, delivered: 1, dead: 0 });
    expect(second.status().counts).toMatchObject({ events: 1, delivered: 1, dead: 0 });
    const database = new Database(join(dataDir, "events.sqlite"), { readonly: true });
    const outboxCount = database.query("SELECT COUNT(*) AS count FROM outbox").get() as { count: number };
    database.close();
    expect(Number(outboxCount.count)).toBe(1);
    second.close();
  });

  test("reclaims an expired lease after broker restart", async () => {
    const dataDir = await temporaryDataDir();
    let clock = new Date("2026-08-06T14:00:00.000Z");
    const first = new DurableEventsBroker({ dataDir, now: () => clock });
    first.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
      retry: { maxAttempts: 3 },
    });
    first.enqueue({ id: "leased-event", source: "notes", type: "note.created", dedupeKey: "leased-event" });
    first.close();

    const database = new Database(join(dataDir, "events.sqlite"));
    database.query(`
      UPDATE outbox
      SET status = 'leased', attempt_count = 1, lease_owner = 'crashed-worker', lease_expires_at = ?
    `).run(clock.getTime() + 1_000);
    database.close();

    const second = new DurableEventsBroker({
      dataDir,
      now: () => clock,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => new Response("queued", { status: 200 }),
    });
    expect(await second.drain({ workerId: "replacement" })).toMatchObject({ claimed: 0, delivered: 0 });
    clock = new Date(clock.getTime() + 1_001);
    expect(await second.drain({ workerId: "replacement" })).toMatchObject({ claimed: 1, delivered: 1 });
    expect(second.status().counts).toMatchObject({ leased: 0, delivered: 1 });
    second.close();
  });

  test("does not claim queued jobs while their current channel is disabled", async () => {
    const dataDir = await temporaryDataDir();
    let calls = 0;
    const broker = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async () => {
        calls += 1;
        return new Response("queued", { status: 202 });
      },
    });
    const channel = {
      id: "notes-created",
      transport: "webhook" as const,
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
    };
    broker.addChannel({ ...channel, enabled: true });
    broker.enqueue({ id: "disable-test", source: "notes", type: "note.created", dedupeKey: "disable-test" });
    broker.addChannel({ ...channel, enabled: false });
    expect(await broker.drain()).toMatchObject({ claimed: 0, delivered: 0 });
    expect(calls).toBe(0);
    broker.addChannel({ ...channel, enabled: true });
    expect(await broker.drain()).toMatchObject({ claimed: 1, delivered: 1 });
    expect(calls).toBe(1);
    broker.close();
  });
});

async function temporaryDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hasna-events-durable-test-"));
  roots.push(root);
  return root;
}
