import { describe, expect, test } from "bun:test";
import { DEFAULT_SIGNATURE_TOLERANCE_MS, isTimestampWithinTolerance, signPayload, verifyPayloadSignature, verifyWebhookSignature } from "./signing.js";

describe("HMAC signing", () => {
  test("signs and verifies timestamped payloads", () => {
    const body = JSON.stringify({ id: "evt_1", type: "ticket.created" });
    const signature = signPayload("secret", "2026-06-16T10:00:00.000Z", body);

    expect(signature).toStartWith("sha256=");
    expect(verifyPayloadSignature("secret", "2026-06-16T10:00:00.000Z", body, signature)).toBe(true);
    expect(verifyPayloadSignature("secret", "2026-06-16T10:00:01.000Z", body, signature)).toBe(false);
  });

  test("can enforce timestamp replay tolerance", () => {
    const body = JSON.stringify({ id: "evt_1", type: "ticket.created" });
    const timestamp = "2026-06-16T10:00:00.000Z";
    const signature = signPayload("secret", timestamp, body);

    expect(isTimestampWithinTolerance(timestamp, 60_000, new Date("2026-06-16T10:00:30.000Z"))).toBe(true);
    expect(isTimestampWithinTolerance(timestamp, 60_000, new Date("2026-06-16T10:02:00.000Z"))).toBe(false);
    expect(verifyWebhookSignature("secret", timestamp, body, signature, {
      toleranceMs: 60_000,
      now: new Date("2026-06-16T10:00:30.000Z"),
    })).toBe(true);
    expect(verifyWebhookSignature("secret", timestamp, body, signature, {
      toleranceMs: 60_000,
      now: new Date("2026-06-16T10:02:00.000Z"),
    })).toBe(false);
  });

  test("rejects stale webhook signatures by default", () => {
    const body = JSON.stringify({ id: "evt_1", type: "ticket.created" });
    const timestamp = "2026-06-16T10:00:00.000Z";
    const signature = signPayload("secret", timestamp, body);

    expect(DEFAULT_SIGNATURE_TOLERANCE_MS).toBe(300_000);
    expect(verifyWebhookSignature("secret", timestamp, body, signature, {
      now: new Date("2026-06-16T10:10:00.000Z"),
    })).toBe(false);
  });
});
