import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEventsCommands } from "./commander.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hasna-events-commander-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("commander adapter", () => {
  test("registers app-scoped webhook and event commands", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    await program.parseAsync(["node", "testapp", "webhooks", "add", "node", "--id", "cmd", "--transport", "command", "--arg", "-e", "--arg", "process.exit(0)"]);
    await program.parseAsync(["node", "testapp", "events", "emit", "testapp.thing.created", "--no-deliver"]);
    await program.parseAsync(["node", "testapp", "webhooks", "remove", "cmd"]);

    expect(program.commands.map((command) => command.name())).toContain("webhooks");
    expect(program.commands.map((command) => command.name())).toContain("events");
  });

  test("honors inherited parent json option", async () => {
    const program = new Command();
    const output: string[] = [];
    const originalLog = console.log;
    program.exitOverride();
    program.option("-j, --json", "Output JSON");
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      await program.parseAsync(["node", "testapp", "-j", "events", "list"]);
    } finally {
      console.log = originalLog;
    }

    expect(output).toEqual(["[]"]);
  });
});
