import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir = "";

async function runCli(args: string[]) {
  const child = Bun.spawn({
    cmd: ["bun", "run", "src/cli/index.ts", "--dir", dataDir, "--json", ...args],
    cwd: process.cwd(),
    env: { ...process.env, HASNA_EVENTS_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function runEmbeddedCli(args: string[]) {
  const child = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `import { runEventsCli } from "./src/cli/index.ts"; await runEventsCli(["--dir", process.env.HASNA_EVENTS_DIR!, "--json", ...${JSON.stringify(args)}], { source: "embedded-test", programName: "embedded" });`,
    ],
    cwd: process.cwd(),
    env: { ...process.env, HASNA_EVENTS_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-events-cli-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CLI smoke behavior", () => {
  test("prints nested group help", async () => {
    const webhooksHelp = await runCli(["webhooks", "--help"]);
    expect(webhooksHelp.exitCode).toBe(0);
    expect(webhooksHelp.stderr).toBe("");
    expect(webhooksHelp.stdout).toContain("events webhooks");
    expect(webhooksHelp.stdout).toContain("webhooks add");

    const eventsHelp = await runCli(["events", "--help"]);
    expect(eventsHelp.exitCode).toBe(0);
    expect(eventsHelp.stderr).toBe("");
    expect(eventsHelp.stdout).toContain("events events");
    expect(eventsHelp.stdout).toContain("events emit");
  });

  test("prints nested command help without mutating channels or events", async () => {
    const addHelp = await runCli(["webhooks", "add", "--help"]);
    expect(addHelp.exitCode).toBe(0);
    expect(addHelp.stderr).toBe("");
    expect(addHelp.stdout).toContain("webhooks add");

    const emitHelp = await runCli(["events", "emit", "--help"]);
    expect(emitHelp.exitCode).toBe(0);
    expect(emitHelp.stderr).toBe("");
    expect(emitHelp.stdout).toContain("events emit");

    const listHooks = await runCli(["webhooks", "list"]);
    expect(JSON.parse(listHooks.stdout)).toEqual([]);

    const listEvents = await runCli(["events", "list"]);
    expect(JSON.parse(listEvents.stdout)).toEqual([]);
  });

  test("can be embedded with app name and default source", async () => {
    const help = await runEmbeddedCli(["events", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("embedded events");
    expect(help.stdout).toContain("default: embedded-test");

    const emit = await runEmbeddedCli(["events", "emit", "embedded.created", "--no-deliver"]);
    expect(emit.exitCode).toBe(0);
    expect(JSON.parse(emit.stdout).event).toMatchObject({
      source: "embedded-test",
      type: "embedded.created",
    });
  });

  test("adds, lists, tests, removes webhooks and emits, lists, replays events", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push(await request.text());
        return new Response("ok");
      },
    });

    try {
      const add = await runCli(["webhooks", "add", `http://127.0.0.1:${server.port}`, "--id", "smoke", "--type", "smoke.*", "--secret", "secret"]);
      expect(add.exitCode).toBe(0);
      expect(JSON.parse(add.stdout)).toMatchObject({ id: "smoke", transport: "webhook", webhook: { secret: "[REDACTED]" } });

      const listHooks = await runCli(["webhooks", "list"]);
      expect(listHooks.exitCode).toBe(0);
      expect(JSON.parse(listHooks.stdout)).toHaveLength(1);
      expect(JSON.parse(listHooks.stdout)[0].webhook.secret).toBe("[REDACTED]");

      const testHook = await runCli(["webhooks", "test", "smoke"]);
      expect(testHook.exitCode).toBe(0);
      expect(JSON.parse(testHook.stdout)).toMatchObject({ channelId: "smoke", status: "success" });

      const emit = await runCli(["events", "emit", "smoke.created", "--source", "cli-test", "--data", "{\"ok\":true}"]);
      expect(emit.exitCode).toBe(0);
      const emitted = JSON.parse(emit.stdout);
      expect(emitted.event).toMatchObject({ source: "cli-test", type: "smoke.created" });
      expect(emitted.deliveries).toHaveLength(1);

      const deduped = await runCli(["events", "emit", "smoke.created", "--source", "cli-test", "--dedupe-key", "smoke:created"]);
      expect(deduped.exitCode).toBe(0);
      const duplicate = await runCli(["events", "emit", "smoke.created", "--source", "cli-test", "--dedupe-key", "smoke:created"]);
      expect(duplicate.exitCode).toBe(0);
      expect(JSON.parse(duplicate.stdout).deduped).toBe(true);

      const listEvents = await runCli(["events", "list", "--limit", "1"]);
      expect(listEvents.exitCode).toBe(0);
      expect(JSON.parse(listEvents.stdout)[0]).toMatchObject({ type: "smoke.created" });

      const replay = await runCli(["events", "replay", "--dry-run"]);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout).events.length).toBe(2);

      const remove = await runCli(["webhooks", "remove", "smoke"]);
      expect(remove.exitCode).toBe(0);
      expect(JSON.parse(remove.stdout)).toEqual({ removed: true });
      expect(requests.length).toBeGreaterThanOrEqual(2);
    } finally {
      server.stop(true);
    }
  });

  test("uses command transport --arg values without forwarding --arg to the process", async () => {
    const receiverPath = join(dataDir, "receiver.js");
    const outputPath = join(dataDir, "received.jsonl");
    writeFileSync(receiverPath, `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(outputPath)}, process.env.HASNA_EVENT_JSON + "\\n");\n`);

    const add = await runCli([
      "webhooks",
      "add",
      "bun",
      "--id",
      "command-hook",
      "--transport",
      "command",
      "--type",
      "command.*",
      "--arg",
      receiverPath,
    ]);
    expect(add.exitCode).toBe(0);
    expect(JSON.parse(add.stdout)).toMatchObject({
      id: "command-hook",
      command: { command: "bun", args: [receiverPath] },
    });

    const emit = await runCli(["events", "emit", "command.created", "--source", "cli-test"]);
    expect(emit.exitCode).toBe(0);
    expect(JSON.parse(emit.stdout).deliveries[0]).toMatchObject({ channelId: "command-hook", status: "success" });

    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, "utf-8").trim())).toMatchObject({
      source: "cli-test",
      type: "command.created",
    });
  });
});
