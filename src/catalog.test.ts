import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, EventsClient } from "./index.js";
import { JsonEventsStore } from "./storage.js";
import {
  createDistributionEventDefinitions,
  DISTRIBUTION_EVENT_CONTRACT_SCHEMAS,
  DISTRIBUTION_EVENT_TYPES,
  EventTypeCatalog,
  EventValidationError,
  registerDistributionEventTypes,
  validateAnnouncementSentData,
  validateAppInstalledData,
  validateFeedbackCreatedData,
  validateFeedbackTriagedData,
  validateReleasePublishedData,
  validateRolloutData,
  type ReleasePublishedData,
} from "./catalog.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-events-catalog-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeCatalog(): EventTypeCatalog {
  return registerDistributionEventTypes(new EventTypeCatalog());
}

const releaseData: ReleasePublishedData = {
  appId: "open-todos",
  package: "@hasna/todos",
  version: "0.11.63",
  gitSha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  publishPath: "skill",
};

const rolloutData = {
  appId: "open-todos",
  package: "@hasna/todos",
  version: "0.11.63",
  machine: "spark01",
  action: "update",
  result: "succeeded",
} as const;

describe("EventTypeCatalog", () => {
  test("registers all distribution event types with contracts schema bindings", () => {
    const catalog = makeCatalog();
    const types = Object.values(DISTRIBUTION_EVENT_TYPES);
    expect(catalog.list().map((definition) => definition.type).sort()).toEqual([...types].sort());
    for (const type of types) {
      expect(catalog.get(type)?.contractSchemaId).toBe(DISTRIBUTION_EVENT_CONTRACT_SCHEMAS[type]);
    }
  });

  test("unregistered types always validate ok", () => {
    const catalog = makeCatalog();
    const event = createEvent({ source: "tickets", type: "ticket.created", data: { anything: true } });
    expect(catalog.validateEvent(event)).toEqual({ ok: true });
    expect(() => catalog.assertEventValid(event)).not.toThrow();
  });

  test("register and unregister round-trip", () => {
    const catalog = new EventTypeCatalog();
    catalog.register({ type: "custom.type", validate: () => ({ ok: false, issues: [{ path: "x", message: "nope" }] }) });
    expect(catalog.has("custom.type")).toBe(true);
    const event = createEvent({ source: "custom", type: "custom.type" });
    expect(catalog.validateEvent(event).ok).toBe(false);
    expect(catalog.unregister("custom.type")).toBe(true);
    expect(catalog.validateEvent(event)).toEqual({ ok: true });
  });

  test("validates registered distribution payloads through validateEvent", () => {
    const catalog = makeCatalog();
    const good = createEvent({ source: "open-publish", type: "release.published", data: releaseData });
    expect(catalog.validateEvent(good)).toEqual({ ok: true });

    const bad = createEvent({ source: "open-publish", type: "release.published", data: { appId: "open-todos" } });
    const result = catalog.validateEvent(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path).sort()).toEqual(["package", "version"]);
    }
    expect(() => catalog.assertEventValid(bad)).toThrow(EventValidationError);
  });
});

describe("distribution payload validators", () => {
  const envelope = (type: string, data: Record<string, unknown>) => createEvent({ source: "test", type, data });

  test("release.published requires appId/package/version and valid publishPath", () => {
    expect(validateReleasePublishedData(releaseData, envelope("release.published", releaseData)).ok).toBe(true);
    const bad = { ...releaseData, publishPath: "manual" };
    const result = validateReleasePublishedData(bad, envelope("release.published", bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("publishPath");
  });

  test("rollout validators require machine and require result on completed/failed", () => {
    expect(validateRolloutData(rolloutData, envelope("release.rollout.started", rolloutData)).ok).toBe(true);

    const noResult = { appId: "open-todos", package: "@hasna/todos", version: "0.11.63", machine: "spark01" };
    expect(validateRolloutData(noResult, envelope("release.rollout.started", noResult)).ok).toBe(true);
    expect(validateRolloutData(noResult, envelope("release.rollout.completed", noResult)).ok).toBe(false);
    expect(validateRolloutData(noResult, envelope("release.rollout.failed", noResult)).ok).toBe(false);

    const noMachine = { appId: "open-todos", package: "@hasna/todos", version: "0.11.63" };
    const result = validateRolloutData(noMachine, envelope("release.rollout.started", noMachine));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("machine");
  });

  test("app.installed requires appId/package/version/machine", () => {
    const good = { appId: "open-todos", package: "@hasna/todos", version: "0.11.63", machine: "spark01" };
    expect(validateAppInstalledData(good, envelope("app.installed", good)).ok).toBe(true);
    expect(validateAppInstalledData({ ...good, machine: "" }, envelope("app.installed", good)).ok).toBe(false);
  });

  test("announcement.sent requires campaignId and string-array channels", () => {
    const good = { campaignId: "campaign_1", audienceId: "oss-operators", channels: ["email", "telegram"] };
    expect(validateAnnouncementSentData(good, envelope("announcement.sent", good)).ok).toBe(true);
    expect(validateAnnouncementSentData({ channels: ["email"] }, envelope("announcement.sent", {})).ok).toBe(false);
    expect(validateAnnouncementSentData({ campaignId: "c", channels: [1] }, envelope("announcement.sent", {})).ok).toBe(false);
  });

  test("feedback validators require feedbackId and triage disposition", () => {
    expect(validateFeedbackCreatedData({ feedbackId: "fb_1" }, envelope("feedback.created", {})).ok).toBe(true);
    expect(validateFeedbackCreatedData({}, envelope("feedback.created", {})).ok).toBe(false);
    expect(validateFeedbackTriagedData({ feedbackId: "fb_1", disposition: "bug" }, envelope("feedback.triaged", {})).ok).toBe(true);
    expect(validateFeedbackTriagedData({ feedbackId: "fb_1" }, envelope("feedback.triaged", {})).ok).toBe(false);
  });

  test("createDistributionEventDefinitions returns fresh definitions", () => {
    const first = createDistributionEventDefinitions();
    const second = createDistributionEventDefinitions();
    expect(first).not.toBe(second);
    expect(first.map((definition) => definition.type)).toEqual(second.map((definition) => definition.type));
  });
});

describe("EventsClient emit-time validator hook", () => {
  const badRelease = { appId: "open-todos" };

  test("validation is OFF by default: registered type with bad payload still emits", async () => {
    const client = new EventsClient({ store: new JsonEventsStore(dataDir), catalog: makeCatalog() });
    const result = await client.emit({ source: "open-publish", type: "release.published", data: badRelease });
    expect(result.deduped).toBe(false);
    expect(await client.listEvents()).toHaveLength(1);
  });

  test("opt-in validation rejects registered types with invalid payloads before storing", async () => {
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      catalog: makeCatalog(),
      validateCatalogTypes: true,
    });
    await expect(
      client.emit({ source: "open-publish", type: "release.published", data: badRelease }),
    ).rejects.toThrow(EventValidationError);
    expect(await client.listEvents()).toHaveLength(0);
  });

  test("opt-in validation accepts registered types with valid payloads", async () => {
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      catalog: makeCatalog(),
      validateCatalogTypes: true,
    });
    const result = await client.emit({ source: "open-publish", type: "release.published", data: releaseData });
    expect(result.event.data.appId).toBe("open-todos");
    expect(await client.listEvents()).toHaveLength(1);
  });

  test("opt-in validation leaves unregistered/free-form types untouched", async () => {
    const client = new EventsClient({
      store: new JsonEventsStore(dataDir),
      catalog: makeCatalog(),
      validateCatalogTypes: true,
    });
    const result = await client.emit({ source: "tickets", type: "ticket.created", data: { whatever: 1 } });
    expect(result.deduped).toBe(false);
    expect(await client.listEvents()).toHaveLength(1);
  });

  test("per-emit validate option overrides the client setting in both directions", async () => {
    const catalog = makeCatalog();
    const offClient = new EventsClient({ store: new JsonEventsStore(dataDir), catalog });
    await expect(
      offClient.emit({ source: "open-publish", type: "release.published", data: badRelease }, { validate: true }),
    ).rejects.toThrow(EventValidationError);

    const onClient = new EventsClient({ store: new JsonEventsStore(dataDir), catalog, validateCatalogTypes: true });
    const result = await onClient.emit(
      { source: "open-publish", type: "release.published", data: badRelease },
      { validate: false },
    );
    expect(result.deduped).toBe(false);
  });

  test("does not use the shared default catalog registrations unless opted in", async () => {
    // Even if some other module registered the distribution types on the
    // default catalog, clients that did not enable validation are untouched.
    const client = new EventsClient({ store: new JsonEventsStore(dataDir) });
    const result = await client.emit({ source: "open-publish", type: "release.published", data: badRelease });
    expect(result.deduped).toBe(false);
  });
});
