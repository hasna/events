import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[2] === "worker") {
  const { DurableEventSpool } = await import("@hasna/events/durable-spool");
  const spool = new DurableEventSpool({ dataDir: process.argv[3] });
  const result = await spool.enqueue({
    id: "notes:note:node-smoke:created",
    source: "notes",
    type: "note.created",
    time: "2026-08-06T13:00:00.000Z",
    dedupeKey: "notes:note:node-smoke:created",
    schemaVersion: "notes.v1",
    data: { noteId: "node-smoke" },
    metadata: {},
  });
  process.stdout.write(JSON.stringify({ stored: result.stored, deduped: result.deduped }));
  process.exit(0);
}

const dataDir = await mkdtemp(join(tmpdir(), "hasna-events-node-spool-smoke-"));
try {
  const results = await Promise.all([runWorker(dataDir), runWorker(dataDir)]);
  assert.equal(results.filter((result) => result.stored).length, 1);
  assert.equal(results.filter((result) => result.deduped).length, 1);
  const finals = (await readdir(join(dataDir, "spool", "inbox"))).filter((name) => name.endsWith(".json"));
  assert.equal(finals.length, 1);
  process.stdout.write("node durable spool smoke: ok\n");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

function runWorker(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "worker", dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`node spool worker failed: ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}
