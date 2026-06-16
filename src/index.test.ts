import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventsClient, sanitizeChannelForOutput } from "./index.js";
import { JsonEventsStore } from "./storage.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-events-client-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("EventsClient", () => {
  test("does not deliver to disabled channels", async () => {
    let calls = 0;
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      fetchImpl: async () => {
        calls += 1;
        return new Response("ok");
      },
    });
    await client.addChannel({
      id: "disabled-hook",
      enabled: false,
      transport: "webhook",
      webhook: { url: "https://example.test" },
    });

    const result = await client.emit({ source: "tickets", type: "ticket.created" });
    expect(result.deliveries).toEqual([]);
    expect(calls).toBe(0);
  });

  test("records failed delivery attempts and retry backoff metadata", async () => {
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      fetchImpl: async () => new Response("bad", { status: 500 }),
    });
    await client.addChannel({
      id: "retry-hook",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.test" },
      retry: { maxAttempts: 2, backoffMs: 1 },
    });

    const result = await client.emit({ source: "tickets", type: "ticket.created" });
    expect(result.deliveries[0].status).toBe("failed");
    expect(result.deliveries[0].attempts).toHaveLength(2);
    expect(result.deliveries[0].attempts[0].nextBackoffMs).toBe(1);
    expect(await client.listDeliveries()).toHaveLength(1);
  });

  test("applies redaction hooks before delivery", async () => {
    let delivered: Record<string, unknown> | undefined;
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      fetchImpl: async (_url, init) => {
        delivered = JSON.parse(String(init?.body));
        return new Response("ok");
      },
    });
    await client.addChannel({
      id: "redacted-hook",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.test" },
      redact: { paths: ["data.token"] },
    });

    await client.emit({ source: "security", type: "secret.used", data: { token: "secret" } });
    expect(delivered?.data).toEqual({ token: "[REDACTED]" });
  });

  test("redacts sensitive event keys before storage and delivery by default", async () => {
    let delivered: Record<string, unknown> | undefined;
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      fetchImpl: async (_url, init) => {
        delivered = JSON.parse(String(init?.body));
        return new Response("ok");
      },
    });
    await client.addChannel({
      id: "hook",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.test" },
    });

    await client.emit({
      source: "security",
      type: "secret.used",
      data: { token: "secret-token", nested: { apiKey: "secret-key", ok: true } },
      metadata: { authorization: "Bearer abc", safe: "yes" },
    });

    const stored = await client.listEvents();
    expect(stored[0]?.data).toEqual({ token: "[REDACTED]", nested: { apiKey: "[REDACTED]", ok: true } });
    expect(stored[0]?.metadata).toEqual({ authorization: "[REDACTED]", safe: "yes" });
    expect(delivered?.data).toEqual({ token: "[REDACTED]", nested: { apiKey: "[REDACTED]", ok: true } });
  });

  test("can opt out of sensitive event key redaction", async () => {
    const client = new EventsClient({ store: new JsonEventsStore(dataDir) });
    await client.emit(
      { source: "security", type: "secret.used", data: { token: "secret-token" } },
      { deliver: false, redactSensitiveData: false },
    );

    expect((await client.listEvents())[0]?.data).toEqual({ token: "secret-token" });
  });

  test("dedupes events by explicit id or dedupe key by default", async () => {
    let calls = 0;
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      fetchImpl: async () => {
        calls += 1;
        return new Response("ok");
      },
    });
    await client.addChannel({
      id: "hook",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.test" },
    });

    const first = await client.emit({ id: "evt_same", source: "repos", type: "repo.synced", dedupeKey: "repos:open-events:synced" });
    const second = await client.emit({ id: "evt_other", source: "repos", type: "repo.synced", dedupeKey: "repos:open-events:synced" });
    const third = await client.emit({ id: "evt_same", source: "repos", type: "repo.synced" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(third.deduped).toBe(true);
    expect(await client.listEvents()).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("can opt out of dedupe for replay-like callers", async () => {
    const client = new EventsClient({ store: new JsonEventsStore(dataDir) });
    await client.emit({ id: "evt_repeat", source: "repos", type: "repo.synced" }, { deliver: false });
    const second = await client.emit({ id: "evt_repeat", source: "repos", type: "repo.synced" }, { deliver: false, dedupe: false });

    expect(second.deduped).toBe(false);
    expect(await client.listEvents()).toHaveLength(2);
  });

  test("sanitizes channel secrets for output", () => {
    const channel = sanitizeChannelForOutput({
      id: "hook",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.test", secret: "secret" },
      command: { command: "node", env: { API_KEY: "abc", SAFE_VALUE: "ok" } },
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });

    expect(channel.webhook?.secret).toBe("[REDACTED]");
    expect(channel.command?.env?.API_KEY).toBe("[REDACTED]");
    expect(channel.command?.env?.SAFE_VALUE).toBe("ok");
  });
});
