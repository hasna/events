import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableEventSpool } from "./durable-spool.js";
import { DurableEventsBroker } from "./durable.js";
import { createEvent } from "./index.js";
import { verifyWebhookSignature } from "./signing.js";
import { dispatchWebhook } from "./transports.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable receiver acknowledgement contract", () => {
  test("acknowledges only verified, fresh events after durable deduped enqueue", async () => {
    const receiverDir = await temporaryDataDir("receiver");
    const senderDir = await temporaryDataDir("sender");
    const receiverSpool = new DurableEventSpool({ dataDir: receiverDir });
    const signingSecret = "receiver-contract-test-secret";
    let receiverNow = new Date("2026-08-06T16:00:00.000Z");
    let failDurableEnqueue = false;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.text();
        const timestamp = request.headers.get("x-hasna-timestamp") ?? "";
        const signature = request.headers.get("x-hasna-signature") ?? "";
        if (!verifyWebhookSignature(signingSecret, timestamp, body, signature, { now: receiverNow })) {
          return new Response("invalid signature", { status: 401 });
        }
        if (failDurableEnqueue) return new Response("durable queue unavailable", { status: 503 });
        await receiverSpool.enqueue(JSON.parse(body));
        return new Response("durably queued", { status: 202 });
      },
    });

    const channel = {
      id: "receiver-contract",
      enabled: true,
      transport: "webhook" as const,
      webhook: { url: `http://127.0.0.1:${server.port}`, secretRef: "env:RECEIVER_CONTRACT_SECRET" },
      createdAt: receiverNow.toISOString(),
      updatedAt: receiverNow.toISOString(),
    };

    try {
      const duplicateEvent = createEvent({
        id: "notes:note:receiver-duplicate:created",
        source: "notes",
        type: "note.created",
        time: "2020-01-01T00:00:00.000Z",
        dedupeKey: "notes:note:receiver-duplicate:created",
        schemaVersion: "notes.v1",
        data: { noteId: "receiver-duplicate" },
      });
      const dispatchOptions = {
        secretResolver: () => signingSecret,
        now: () => receiverNow,
      };
      expect((await dispatchWebhook(duplicateEvent, channel, dispatchOptions)).status).toBe("success");
      expect((await dispatchWebhook(duplicateEvent, channel, dispatchOptions)).status).toBe("success");
      expect(await finalRecordCount(receiverSpool.inboxDir)).toBe(1);

      const wrongSignature = await dispatchWebhook(duplicateEvent, channel, {
        secretResolver: () => "incorrect-test-secret",
        now: () => receiverNow,
      });
      expect(wrongSignature).toMatchObject({ status: "failed", responseStatus: 401 });

      const expired = await dispatchWebhook(duplicateEvent, channel, {
        secretResolver: () => signingSecret,
        now: () => new Date(receiverNow.getTime() - 6 * 60 * 1_000),
      });
      expect(expired).toMatchObject({ status: "failed", responseStatus: 401 });

      const sender = new DurableEventsBroker({
        dataDir: senderDir,
        now: () => receiverNow,
        secretResolver: () => signingSecret,
      });
      sender.addChannel({
        id: "notes-created",
        enabled: true,
        transport: "webhook",
        filters: [{ source: "notes", type: "note.created" }],
        webhook: { url: `http://127.0.0.1:${server.port}`, secretRef: "env:RECEIVER_CONTRACT_SECRET" },
        retry: { maxAttempts: 3, backoffMs: 10, multiplier: 1 },
      });
      sender.enqueue({
        id: "notes:note:receiver-retry:created",
        source: "notes",
        type: "note.created",
        dedupeKey: "notes:note:receiver-retry:created",
        schemaVersion: "notes.v1",
        data: { noteId: "receiver-retry" },
      });

      failDurableEnqueue = true;
      expect(await sender.drain()).toMatchObject({ claimed: 1, delivered: 0, retried: 1 });
      expect(sender.status().counts).toMatchObject({ pending: 1, delivered: 0 });
      failDurableEnqueue = false;
      receiverNow = new Date(receiverNow.getTime() + 11);
      expect(await sender.drain()).toMatchObject({ claimed: 1, delivered: 1, retried: 0 });
      expect(sender.status().counts).toMatchObject({ pending: 0, delivered: 1 });
      expect(await finalRecordCount(receiverSpool.inboxDir)).toBe(2);
      sender.close();
    } finally {
      server.stop(true);
    }
  });
});

async function temporaryDataDir(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `hasna-events-${label}-test-`));
  roots.push(root);
  return root;
}

async function finalRecordCount(inboxDir: string): Promise<number> {
  return (await readdir(inboxDir)).filter((name) => name.endsWith(".json")).length;
}
