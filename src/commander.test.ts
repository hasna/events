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
  test("registers app-scoped channel and event commands", async () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    await program.parseAsync(["node", "testapp", "channels", "add", "node", "--id", "cmd", "--transport", "command", "--arg", "-e", "--arg", "process.exit(0)"]);
    await program.parseAsync(["node", "testapp", "events", "emit", "testapp.thing.created", "--no-deliver"]);
    await program.parseAsync(["node", "testapp", "channels", "remove", "cmd"]);

    expect(program.commands.map((command) => command.name())).toContain("channels");
    expect(program.commands.map((command) => command.name())).toContain("events");
    expect(program.commands.map((command) => command.name())).not.toContain("webhooks");
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

  test("persists data and metadata channel filters from embedded commands", async () => {
    const program = new Command();
    const output: string[] = [];
    const originalLog = console.log;
    program.exitOverride();
    program.option("-j, --json", "Output JSON");
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      await program.parseAsync([
        "node",
        "testapp",
        "channels",
        "add",
        "node",
        "--id",
        "filtered",
        "--transport",
        "command",
        "--type",
        "task.created",
        "--metadata",
        "project_path=/home/hasna/workspace/hasna/opensource/*",
        "--metadata-json",
        "route_enabled=true",
        "--data",
        "short_id=001",
        "--arg",
        "-e",
        "--arg",
        "process.exit(0)",
      ]);
      await program.parseAsync(["node", "testapp", "-j", "channels", "list"]);
    } finally {
      console.log = originalLog;
    }

    const channels = JSON.parse(output.at(-1) ?? "[]");
    expect(channels[0].filters[0].metadata).toEqual({
      project_path: "/home/hasna/workspace/hasna/opensource/*",
      route_enabled: true,
    });
    expect(channels[0].filters[0].data.short_id).toBe("001");
  });

  test("embedded match can override source for route previews", async () => {
    const program = new Command();
    const output: string[] = [];
    const originalLog = console.log;
    program.exitOverride();
    program.option("-j, --json", "Output JSON");
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      await program.parseAsync([
        "node",
        "testapp",
        "channels",
        "add",
        "node",
        "--id",
        "todos-route",
        "--transport",
        "command",
        "--source",
        "todos",
        "--type",
        "task.created",
        "--arg",
        "-e",
        "--arg",
        "process.exit(0)",
      ]);
      await program.parseAsync(["node", "testapp", "-j", "channels", "match", "todos-route", "--source", "todos", "--type", "task.created"]);
    } finally {
      console.log = originalLog;
    }

    expect(JSON.parse(output.at(-1) ?? "{}").matched).toBe(true);
  });
});
