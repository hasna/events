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

  test("keeps legacy * wildcard behavior outside path fields", () => {
    const slashyEvent = createEvent({
      source: "github/repos",
      type: "task.created",
      subject: "repo/open-events",
      data: {},
    });

    expect(eventMatchesFilter(slashyEvent, {
      source: "github/*",
      subject: "repo/*",
    })).toBe(true);
  });

  test("treats * as a path segment wildcard and ** as recursive for path fields", () => {
    const repoEvent = createEvent({
      source: "todos",
      type: "task.created",
      data: {},
      metadata: { project_path: "/home/hasna/workspace/hasna/opensource/open-events" },
    });
    const worktreeEvent = createEvent({
      source: "todos",
      type: "task.created",
      data: {},
      metadata: { project_path: "/home/hasna/workspace/hasna/opensource/open-codewith/.codewith/worktrees/macos" },
    });

    expect(eventMatchesFilter(repoEvent, {
      metadata: { project_path: "/home/hasna/workspace/hasna/opensource/*" },
    })).toBe(true);
    expect(eventMatchesFilter(worktreeEvent, {
      metadata: { project_path: "/home/hasna/workspace/hasna/opensource/*" },
    })).toBe(false);
    expect(eventMatchesFilter(worktreeEvent, {
      metadata: { project_path: "/home/hasna/workspace/hasna/opensource/**" },
    })).toBe(true);
  });

  test("matches array members for string field filters", () => {
    const taskEvent = createEvent({
      source: "todos",
      type: "task.created",
      data: { tags: ["auto:route", "repo:open-events"] },
      metadata: {},
    });

    expect(eventMatchesFilter(taskEvent, {
      data: { tags: "auto:*" },
    })).toBe(true);
    expect(eventMatchesFilter(taskEvent, {
      data: { tags: "manual" },
    })).toBe(false);
  });

  test("supports negative field matchers", () => {
    const taskEvent = createEvent({
      source: "todos",
      type: "task.created",
      data: { priority: "001" },
      metadata: { automation: { no_auto: false }, route_enabled: true },
    });
    const blockedEvent = createEvent({
      source: "todos",
      type: "task.created",
      data: { priority: "001" },
      metadata: { automation: { no_auto: true }, route_enabled: true },
    });

    const filter = {
      metadata: {
        route_enabled: true,
        "automation.no_auto": { not: true },
      },
    };

    expect(eventMatchesFilter(taskEvent, filter)).toBe(true);
    expect(eventMatchesFilter(blockedEvent, filter)).toBe(false);
    expect(eventMatchesFilter(createEvent({ source: "todos", type: "task.created", data: {}, metadata: { route_enabled: true } }), filter)).toBe(true);
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
