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
    expect(() => broker.addChannel({
      id: "reserved-signature",
      enabled: true,
      transport: "webhook",
      webhook: {
        url: "https://example.invalid",
        secretRef: "env:SAFE_REFERENCE",
        headers: { "x-hasna-signature": "forged-signature" },
      },
    })).toThrow("X-Hasna headers are reserved");
    broker.close();
  });

  test("redacts sensitive keys before event persistence and channel paths before outbox persistence", async () => {
    const dataDir = await temporaryDataDir();
    let deliveredBody = "";
    const broker = new DurableEventsBroker({
      dataDir,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async (_input, init) => {
        deliveredBody = String(init?.body);
        return new Response("queued", { status: 202 });
      },
    });
    broker.addChannel({
      id: "redacted-notes",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      redact: { paths: ["data.privateBody"], replacement: "[CHANNEL-REDACTED]" },
      webhook: { url: "https://example.invalid", secretRef: "env:SAFE_REFERENCE" },
    });
    const enqueued = broker.enqueue({
      id: "redaction-event",
      source: "notes",
      type: "note.created",
      data: {
        apiKey: "default-sensitive-canary",
        nested: { authToken: "nested-sensitive-canary" },
        privateBody: "channel-private-canary",
        title: "safe title",
      },
    });
    expect(enqueued.event.data).toEqual({
      apiKey: "[REDACTED]",
      nested: { authToken: "[REDACTED]" },
      privateBody: "channel-private-canary",
      title: "safe title",
    });
    expect(await broker.drain()).toMatchObject({ delivered: 1, lost: 0 });
    broker.close();

    const database = new Database(join(dataDir, "events.sqlite"), { readonly: true });
    const eventJson = String((database.query("SELECT envelope_json AS value FROM events").get() as { value: string }).value);
    const outboxJson = String((database.query("SELECT event_json AS value FROM outbox").get() as { value: string }).value);
    database.close();
    expect(eventJson).not.toContain("default-sensitive-canary");
    expect(eventJson).not.toContain("nested-sensitive-canary");
    expect(outboxJson).not.toContain("default-sensitive-canary");
    expect(outboxJson).not.toContain("nested-sensitive-canary");
    expect(outboxJson).not.toContain("channel-private-canary");
    expect(JSON.parse(outboxJson).data.privateBody).toBe("[CHANNEL-REDACTED]");
    expect(JSON.parse(deliveredBody).data).toMatchObject({
      apiKey: "[REDACTED]",
      nested: { authToken: "[REDACTED]" },
      privateBody: "[CHANNEL-REDACTED]",
      title: "safe title",
    });
  });

  test("rejects invalid or unbounded durable retry policies", async () => {
    const broker = new DurableEventsBroker({ dataDir: await temporaryDataDir() });
    const channel = {
      id: "invalid-retry",
      enabled: true,
      transport: "webhook" as const,
      webhook: { url: "https://example.invalid", secretRef: "env:SAFE_REFERENCE" },
    };
    for (const retry of [
      { maxAttempts: 0 },
      { maxAttempts: Number.POSITIVE_INFINITY },
      { backoffMs: Number.NaN },
      { backoffMs: 365 * 24 * 60 * 60 * 1_000 + 1 },
      { maxAttempts: 3, backoffMs: 20_000_000_000, multiplier: 2 },
      { multiplier: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => broker.addChannel({ ...channel, retry })).toThrow(/retry/);
    }
    expect(() => broker.addChannel({
      ...channel,
      retry: { maxAttempts: 2, backoffMs: 2_147_483_648, multiplier: 1 },
    })).not.toThrow();
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

  test("claims one job at a time and survives a true concurrent lease loss", async () => {
    const dataDir = await temporaryDataDir();
    let clock = new Date("2026-08-06T15:00:00.000Z");
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const deliveredIds: string[] = [];
    const first = new DurableEventsBroker({
      dataDir,
      now: () => clock,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async (_input, init) => {
        deliveredIds.push(JSON.parse(String(init?.body)).id);
        markStarted();
        await firstRelease;
        return new Response("queued", { status: 202 });
      },
    });
    first.addChannel({
      id: "notes-created",
      enabled: true,
      transport: "webhook",
      filters: [{ source: "notes", type: "note.created" }],
      webhook: { url: "https://example.invalid", secretRef: "env:SAFE_REFERENCE" },
      retry: { maxAttempts: 3 },
    });
    first.enqueue({ id: "lease-one", source: "notes", type: "note.created" });
    first.enqueue({ id: "lease-two", source: "notes", type: "note.created" });

    const firstDrain = first.drain({ workerId: "worker-a", limit: 2, leaseMs: 1 });
    await firstStarted;
    const inspection = new Database(join(dataDir, "events.sqlite"), { readonly: true });
    const counts = inspection.query("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all() as Array<{ status: string; count: number }>;
    inspection.close();
    expect(Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]))).toEqual({ leased: 1, pending: 1 });

    clock = new Date(clock.getTime() + 20_001);
    const second = new DurableEventsBroker({
      dataDir,
      now: () => clock,
      secretResolver: () => "runtime-only-test-secret",
      fetchImpl: async (_input, init) => {
        deliveredIds.push(JSON.parse(String(init?.body)).id);
        return new Response("queued", { status: 202 });
      },
    });
    expect(await second.drain({ workerId: "worker-b", limit: 2, leaseMs: 1 })).toMatchObject({
      claimed: 2,
      delivered: 2,
      lost: 0,
    });
    releaseFirst();
    expect(await firstDrain).toMatchObject({ claimed: 1, delivered: 0, lost: 1 });
    expect(deliveredIds).toHaveLength(3);
    expect(new Set(deliveredIds)).toEqual(new Set(["lease-one", "lease-two"]));
    expect(second.status().counts).toMatchObject({ pending: 0, leased: 0, delivered: 2 });
    second.close();
    first.close();
  });

  test("creates and reopens an exact schema v1 from a clean version-0 database", async () => {
    const dataDir = await temporaryDataDir();
    const broker = new DurableEventsBroker({ dataDir });
    expect(broker.status()).toMatchObject({ schemaVersion: 1, counts: { channels: 0, events: 0 } });
    broker.close();

    const path = join(dataDir, "events.sqlite");
    const before = durableSchemaSnapshot(path);
    expect(before.userVersion).toBe(1);
    expect(before.objects.map((object) => object.name)).toEqual([
      "events_dedupe_key_unique",
      "events_source_type_idx",
      "outbox_due_idx",
      "channels",
      "deliveries",
      "events",
      "outbox",
    ]);
    new DurableEventsBroker({ dataDir }).close();
    expect(durableSchemaSnapshot(path)).toEqual(before);
  });

  test("rejects newer and incomplete durable schema versions without rewriting them", async () => {
    const newerDataDir = await temporaryDataDir();
    const newerPath = join(newerDataDir, "events.sqlite");
    const newer = new Database(newerPath, { create: true });
    newer.exec("PRAGMA user_version = 2;");
    newer.close();
    expect(() => new DurableEventsBroker({ dataDir: newerDataDir })).toThrow("newer than supported version 1");
    const unchanged = new Database(newerPath, { readonly: true });
    expect(Number((unchanged.query("PRAGMA user_version").get() as { user_version: number }).user_version)).toBe(2);
    unchanged.close();

    const incompleteDataDir = await temporaryDataDir();
    const incomplete = new Database(join(incompleteDataDir, "events.sqlite"), { create: true });
    incomplete.exec("CREATE TABLE channels (id TEXT PRIMARY KEY); PRAGMA user_version = 1;");
    incomplete.close();
    expect(() => new DurableEventsBroker({ dataDir: incompleteDataDir })).toThrow("schema version 1 is incompatible");
  });

  test("rejects a populated version-0 application schema without mutating it", async () => {
    const dataDir = await temporaryDataDir();
    const path = join(dataDir, "events.sqlite");
    const database = new Database(path, { create: true });
    createAllNamedSchema(database, { version: 0, enabledType: "TEXT" });
    database.close();
    const before = durableSchemaSnapshot(path);

    expect(() => new DurableEventsBroker({ dataDir })).toThrow("version 0 requires an empty application schema");
    expect(durableSchemaSnapshot(path)).toEqual(before);
  });

  test("rejects all-names-present version-1 shape defects without mutating them", async () => {
    const defects: Array<{ name: string; options: MalformedSchemaOptions }> = [
      { name: "column type", options: { enabledType: "TEXT" } },
      { name: "foreign key", options: { outboxEventReference: "" } },
      { name: "partial unique index", options: { dedupePredicate: "" } },
      { name: "index column order", options: { dueIndexColumns: "available_at, status, lease_expires_at" } },
      { name: "status check", options: { statusValues: "'pending', 'leased', 'delivered'" } },
      { name: "outbox unique constraint", options: { uniqueColumns: "channel_id, event_id" } },
    ];

    for (const defect of defects) {
      const dataDir = await temporaryDataDir();
      const path = join(dataDir, "events.sqlite");
      const database = new Database(path, { create: true });
      createAllNamedSchema(database, { version: 1, ...defect.options });
      database.close();
      const before = durableSchemaSnapshot(path);

      expect(() => new DurableEventsBroker({ dataDir }), defect.name).toThrow("schema version 1 is incompatible");
      expect(durableSchemaSnapshot(path), defect.name).toEqual(before);
    }
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

interface MalformedSchemaOptions {
  version?: number;
  enabledType?: string;
  outboxEventReference?: string;
  dedupePredicate?: string;
  dueIndexColumns?: string;
  statusValues?: string;
  uniqueColumns?: string;
}

function createAllNamedSchema(database: Database, options: MalformedSchemaOptions = {}): void {
  const enabledType = options.enabledType ?? "INTEGER";
  const outboxEventReference = options.outboxEventReference ?? " REFERENCES events(id)";
  const dedupePredicate = options.dedupePredicate ?? " WHERE dedupe_key IS NOT NULL";
  const dueIndexColumns = options.dueIndexColumns ?? "status, available_at, lease_expires_at";
  const statusValues = options.statusValues ?? "'pending', 'leased', 'delivered', 'dead'";
  const uniqueColumns = options.uniqueColumns ?? "event_id, channel_id";
  database.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      enabled ${enabledType} NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      time TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX events_dedupe_key_unique ON events(dedupe_key)${dedupePredicate};
    CREATE INDEX events_source_type_idx ON events(source, type);
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL${outboxEventReference},
      channel_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      channel_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (${statusValues})),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(${uniqueColumns})
    );
    CREATE INDEX outbox_due_idx ON outbox(${dueIndexColumns});
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      channel_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO channels (id, enabled, config_json, created_at, updated_at)
    VALUES ('schema-sentinel', 0, '{}', 'before', 'before');
    PRAGMA user_version = ${options.version ?? 1};
  `);
}

function durableSchemaSnapshot(path: string): {
  userVersion: number;
  schemaVersion: number;
  journalMode: string;
  objects: Array<{ type: string; name: string; table: string; sql: string | null }>;
  channelRows: Array<{ id: string; enabled: number; config_json: string; created_at: string; updated_at: string }>;
} {
  const database = new Database(path, { readonly: true });
  const userVersion = Number((database.query("PRAGMA user_version").get() as { user_version: number }).user_version);
  const schemaVersion = Number((database.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  const journalMode = String((database.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  const objects = (database.query(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE substr(name, 1, 7) <> 'sqlite_'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>).map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: row.sql,
  }));
  let channelRows: Array<{ id: string; enabled: number; config_json: string; created_at: string; updated_at: string }> = [];
  if (objects.some((object) => object.type === "table" && object.name === "channels")) {
    const rows = database.query("SELECT id, enabled, config_json, created_at, updated_at FROM channels ORDER BY id").all();
    channelRows = rows as typeof channelRows;
  }
  database.close();
  return { userVersion, schemaVersion, journalMode, objects, channelRows };
}
