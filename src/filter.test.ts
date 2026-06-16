import { describe, expect, test } from "bun:test";
import { channelMatchesEvent, eventMatchesFilter } from "./filter.js";
import { createEvent } from "./index.js";
import type { ChannelConfig } from "./types.js";

const event = createEvent({
  id: "evt_1",
  source: "tickets",
  type: "ticket.created",
  subject: "ticket:123",
  severity: "notice",
  data: { status: "open", customer: { tier: "pro" } },
  metadata: { tenant: "acme" },
});

describe("event filtering", () => {
  test("matches wildcard event type and nested data", () => {
    expect(eventMatchesFilter(event, {
      source: "tickets",
      type: "ticket.*",
      data: { "customer.tier": "pro" },
      metadata: { tenant: "acme" },
    })).toBe(true);
  });

  test("rejects disabled channels before filters", () => {
    const channel: ChannelConfig = {
      id: "disabled",
      enabled: false,
      transport: "webhook",
      webhook: { url: "https://example.test" },
      filters: [{ type: "ticket.*" }],
      createdAt: event.time,
      updatedAt: event.time,
    };
    expect(channelMatchesEvent(channel, event)).toBe(false);
  });
});
