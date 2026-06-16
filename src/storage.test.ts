import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonEventsStore } from "./storage.js";
import type { ChannelConfig } from "./types.js";

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
});
