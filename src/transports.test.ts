import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent } from "./index.js";
import { dispatchCommand, dispatchWebhook } from "./transports.js";
import { verifyPayloadSignature, verifyWebhookSignature } from "./signing.js";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hasna-events-transports-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("transports", () => {
  test("POSTs webhook payload with Hasna headers and signature", async () => {
    let received: { headers: Headers; body: string } | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received = { headers: request.headers, body: await request.text() };
        return new Response("ok");
      },
    });

    try {
      const event = createEvent({
        id: "evt_webhook",
        source: "tickets",
        type: "ticket.created",
        time: "2026-06-16T10:00:00.000Z",
        data: { ticketId: 123 },
      });
      const dispatchTime = "2026-08-06T10:05:00.000Z";
      const attempt = await dispatchWebhook(event, {
        id: "hook",
        enabled: true,
        transport: "webhook",
        webhook: { url: `http://127.0.0.1:${server.port}`, secret: "shared-secret" },
        createdAt: event.time,
        updatedAt: event.time,
      }, { now: () => new Date(dispatchTime) });

      expect(attempt.status).toBe("success");
      expect(received?.headers.get("x-hasna-event-id")).toBe("evt_webhook");
      expect(received?.headers.get("x-hasna-event-type")).toBe("ticket.created");
      expect(received?.headers.get("x-hasna-timestamp")).toBe(dispatchTime);
      expect(JSON.parse(received?.body ?? "{}")).toMatchObject({ id: "evt_webhook", time: "2026-06-16T10:00:00.000Z", data: { ticketId: 123 } });
      expect(verifyPayloadSignature(
        "shared-secret",
        dispatchTime,
        received?.body ?? "",
        received?.headers.get("x-hasna-signature") ?? "",
      )).toBe(true);
      expect(verifyWebhookSignature(
        "shared-secret",
        dispatchTime,
        received?.body ?? "",
        received?.headers.get("x-hasna-signature") ?? "",
        { now: new Date(dispatchTime) },
      )).toBe(true);
      expect(verifyWebhookSignature(
        "shared-secret",
        dispatchTime,
        received?.body ?? "",
        received?.headers.get("x-hasna-signature") ?? "",
        { now: new Date(Date.parse(dispatchTime) + 6 * 60 * 1_000) },
      )).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("rejects custom headers that could forge signed Hasna metadata", async () => {
    const event = createEvent({ id: "evt-protected", source: "notes", type: "note.created" });
    for (const name of ["X-Hasna-Signature", "x-hasna-timestamp", "X-HASNA-EVENT-ID"]) {
      await expect(dispatchWebhook(event, {
        id: "protected-header",
        enabled: true,
        transport: "webhook",
        webhook: {
          url: "https://example.invalid",
          secret: "runtime-secret",
          headers: { [name]: "attacker-controlled" },
        },
        createdAt: event.time,
        updatedAt: event.time,
      })).rejects.toThrow("reserved for signed delivery metadata");
    }
  });

  test("exposes command dispatch env vars and event JSON on stdin", async () => {
    const outputPath = join(tempDir, "command.json");
    const scriptPath = join(tempDir, "capture.js");
    writeFileSync(scriptPath, `
const fs = require("fs");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({
    id: process.env.HASNA_EVENT_ID,
    type: process.env.HASNA_EVENT_TYPE,
    source: process.env.HASNA_EVENT_SOURCE,
    json: JSON.parse(process.env.HASNA_EVENT_JSON),
    stdin: JSON.parse(input)
  }));
});
`);

    const event = createEvent({ id: "evt_command", source: "repos", type: "repo.synced", data: { repo: "open-events" } });
    const attempt = await dispatchCommand(event, {
      id: "cmd",
      enabled: true,
      transport: "command",
      command: { command: process.execPath, args: [scriptPath, outputPath] },
      createdAt: event.time,
      updatedAt: event.time,
    });

    expect(attempt.status).toBe("success");
    const captured = JSON.parse(await Bun.file(outputPath).text());
    expect(captured).toMatchObject({
      id: "evt_command",
      type: "repo.synced",
      source: "repos",
      json: { id: "evt_command" },
      stdin: { id: "evt_command" },
    });
  });

  test("reports delivery failures for non-2xx webhook responses", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 503 }),
    });

    try {
      const event = createEvent({ source: "monitor", type: "check.failed" });
      const attempt = await dispatchWebhook(event, {
        id: "failing",
        enabled: true,
        transport: "webhook",
        webhook: { url: `http://127.0.0.1:${server.port}` },
        createdAt: event.time,
        updatedAt: event.time,
      });
      expect(attempt.status).toBe("failed");
      expect(attempt.responseStatus).toBe(503);
      expect(attempt.error).toContain("HTTP 503");
    } finally {
      server.stop(true);
    }
  });

  test("resolves webhook signing secrets only at dispatch time", async () => {
    let signature = "";
    let body = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        signature = request.headers.get("x-hasna-signature") ?? "";
        body = await request.text();
        return new Response("queued", { status: 202 });
      },
    });
    try {
      const event = createEvent({
        id: "evt_ref",
        source: "notes",
        type: "note.created",
        time: "2026-08-06T12:00:00.000Z",
      });
      const channel = {
        id: "notes",
        enabled: true,
        transport: "webhook" as const,
        webhook: { url: `http://127.0.0.1:${server.port}`, secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET" },
        createdAt: event.time,
        updatedAt: event.time,
      };
      const attempt = await dispatchWebhook(event, channel, {
        secretResolver: async (reference) => reference === "env:HASNA_NOTES_WEBHOOK_SECRET" ? "runtime-secret" : undefined,
        now: () => new Date(event.time),
      });
      expect(attempt.status).toBe("success");
      expect(verifyPayloadSignature("runtime-secret", event.time, body, signature)).toBe(true);

      const unresolved = await dispatchWebhook(event, channel);
      expect(unresolved.status).toBe("failed");
      expect(unresolved.error).toBe("Webhook secret reference has no runtime resolver");
    } finally {
      server.stop(true);
    }
  });
});
