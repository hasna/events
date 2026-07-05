import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLocalJsonEventCursor, JsonEventsStore } from "./storage.js";
import type { ChannelConfig, EventEnvelope } from "./types.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-events-storage-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("JsonEventsStore", () => {
  test("stores, updates, lists, and removes channel config", async () => {
    const store = new JsonEventsStore(dataDir);
    const now = new Date().toISOString();
    const channel: ChannelConfig = {
      id: "billing-webhook",
      enabled: true,
      transport: "webhook",
      webhook: { url: "https://example.test/events" },
      filters: [{ type: "invoice.*" }],
      createdAt: now,
      updatedAt: now,
    };

    await store.addChannel(channel);
    expect(await store.listChannels()).toHaveLength(1);

    const reloaded = new JsonEventsStore(dataDir);
    expect(await reloaded.getChannel("billing-webhook")).toMatchObject({
      id: "billing-webhook",
      transport: "webhook",
      webhook: { url: "https://example.test/events" },
    });

    await reloaded.addChannel({ ...channel, enabled: false });
    expect((await reloaded.getChannel("billing-webhook"))?.enabled).toBe(false);

    expect(await reloaded.removeChannel("billing-webhook")).toBe(true);
    expect(await reloaded.listChannels()).toEqual([]);
  });

  test("creates private store files", async () => {
    const store = new JsonEventsStore(dataDir);
    await store.init();

    expect((statSync(dataDir).mode & 0o777).toString(8)).toBe("700");
    for (const name of ["channels.json", "events.json", "deliveries.json"]) {
      expect((statSync(join(dataDir, name)).mode & 0o777).toString(8)).toBe("600");
    }
  });

  test("appends events idempotently by dedupe identity", async () => {
    const store = new JsonEventsStore(dataDir);
    const event = makeEvent({ id: "evt_1", dedupeKey: "tickets:1:created" });

    const first = await store.appendEventOnce(event);
    const duplicate = await store.appendEventOnce(makeEvent({ id: "evt_2", dedupeKey: "tickets:1:created" }));
    const explicitDuplicate = await store.appendEventOnce(makeEvent({ id: "evt_1" }));
    const forced = await store.appendEventOnce(makeEvent({ id: "evt_1" }), { dedupe: false });

    expect(first).toMatchObject({ stored: true, deduped: false, event: { id: "evt_1" } });
    expect(duplicate).toMatchObject({ stored: false, deduped: true, event: { id: "evt_1" } });
    expect(explicitDuplicate).toMatchObject({ stored: false, deduped: true, event: { id: "evt_1" } });
    expect(forced).toMatchObject({ stored: true, deduped: false, event: { id: "evt_1" } });
    expect(await store.listEvents()).toHaveLength(2);
  });

  test("lists event pages with opaque cursors", async () => {
    const store = new JsonEventsStore(dataDir);
    await store.appendEvent(makeEvent({ id: "evt_1", source: "tickets" }));
    await store.appendEvent(makeEvent({ id: "evt_2", source: "tickets" }));
    await store.appendEvent(makeEvent({ id: "evt_3", source: "billing" }));
    await store.appendEvent(makeEvent({ id: "evt_4", source: "tickets" }));

    const first = await store.listEventsPage({ source: "tickets", limit: 2 });
    const second = await store.listEventsPage({ source: "tickets", cursor: first.nextCursor, limit: 2 });

    expect(first.events.map((event) => event.id)).toEqual(["evt_1", "evt_2"]);
    expect(first.nextCursor).toBe(encodeLocalJsonEventCursor(2, { source: "tickets" }));
    expect(first.hasMore).toBe(true);
    expect(second.events.map((event) => event.id)).toEqual(["evt_4"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.hasMore).toBe(false);

    let mismatchError: Error | undefined;
    try {
      await store.listEventsPage({ source: "billing", cursor: first.nextCursor, limit: 2 });
    } catch (error) {
      mismatchError = error as Error;
    }
    expect(mismatchError?.message).toContain("source filter mismatch");
  });
});

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: "evt_default",
    source: "tickets",
    type: "ticket.created",
    time: "2026-07-05T00:00:00.000Z",
    severity: "info",
    data: {},
    schemaVersion: "1.0",
    metadata: {},
    ...overrides,
  };
}
