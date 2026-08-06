import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableEventSpool } from "./durable-spool.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DurableEventSpool", () => {
  test("preserves stable arbitrary ids and converges concurrent duplicate writers", async () => {
    const dataDir = await temporaryDataDir();
    const first = new DurableEventSpool({ dataDir });
    const second = new DurableEventSpool({ dataDir });
    const input = {
      id: "notes:note:4af6e0dd:created",
      source: "notes",
      type: "note.created",
      time: "2026-08-06T10:30:00.000Z",
      subject: "note:4af6e0dd",
      dedupeKey: "notes:note:4af6e0dd:created",
      schemaVersion: "notes.v1",
      data: {
        noteId: "4af6e0dd",
        createdAt: "2026-08-06T10:30:00.000Z",
        originMachine: "station03",
      },
      metadata: {},
    };

    const results = await Promise.all([first.enqueue(input), second.enqueue(input)]);
    expect(results.filter((result) => result.stored)).toHaveLength(1);
    expect(results.filter((result) => result.deduped)).toHaveLength(1);

    const inbox = join(dataDir, "spool", "inbox");
    const names = (await readdir(inbox)).filter((name) => name.endsWith(".json"));
    expect(names).toEqual(["6b43639f4e75411f2dd94b7d614ae05d3e574ade22039270ea1bddec52a058ad.json"]);
    const stored = JSON.parse(await readFile(join(inbox, names[0]!), "utf8"));
    expect(stored).toEqual({ ...input, severity: "info" });
    expect((await stat(join(inbox, names[0]!))).mode & 0o777).toBe(0o600);
  });

  test("recovers complete stale temp files and cleans invalid leftovers", async () => {
    const dataDir = await temporaryDataDir();
    const spool = new DurableEventSpool({ dataDir });
    await spool.enqueue({ id: "seed", source: "notes", type: "note.created" });
    const inbox = spool.inboxDir;
    const event = {
      id: "recovered",
      source: "notes",
      type: "note.created",
      time: "2026-08-06T10:31:00.000Z",
      severity: "info",
      data: {},
      schemaVersion: "1.0",
      metadata: {},
    };
    const validTemp = join(inbox, ".tmp-crashed-valid");
    const invalidTemp = join(inbox, ".tmp-crashed-invalid");
    await Bun.write(validTemp, `${JSON.stringify(event)}\n`);
    await Bun.write(invalidTemp, "partial");
    const stale = new Date(Date.now() - 5_000);
    await utimes(validTemp, stale, stale);
    await utimes(invalidTemp, stale, stale);

    const result = await spool.recover({ olderThanMs: 0 });
    expect(result).toEqual({ recovered: 1, deduped: 0, cleaned: 1 });
    expect((await readdir(inbox)).some((name) => name.startsWith(".tmp-"))).toBe(false);
  });

  test("redacts sensitive keys before persisting the producer spool record", async () => {
    const dataDir = await temporaryDataDir();
    const spool = new DurableEventSpool({ dataDir });
    const result = await spool.enqueue({
      id: "producer-redaction",
      source: "notes",
      type: "note.created",
      data: {
        apiKey: "producer-sensitive-canary",
        nested: { accessToken: "nested-producer-canary" },
        title: "safe title",
      },
    });
    expect(result.event.data).toEqual({
      apiKey: "[REDACTED]",
      nested: { accessToken: "[REDACTED]" },
      title: "safe title",
    });
    const [name] = (await readdir(spool.inboxDir)).filter((entry) => entry.endsWith(".json"));
    const stored = await readFile(join(spool.inboxDir, name!), "utf8");
    expect(stored).not.toContain("producer-sensitive-canary");
    expect(stored).not.toContain("nested-producer-canary");
  });
});

async function temporaryDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hasna-events-spool-test-"));
  roots.push(root);
  return root;
}
