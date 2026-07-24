import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EVENT_LIST_LIMIT, registerEventsCommands } from "./commander.js";

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

  test("channels test on an unknown channel emits a clean JSON error, honoring --json", async () => {
    const program = new Command();
    const output: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const previousExitCode = process.exitCode;
    program.exitOverride();
    program.option("-j, --json", "Output JSON");
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      console.error = (value?: unknown) => errors.push(String(value));
      await program.parseAsync(["node", "testapp", "-j", "channels", "test", "no-such-channel-xyz"]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(errors).toEqual([]);
    expect(JSON.parse(output.at(-1) ?? "{}")).toEqual({ error: "Channel not found: no-such-channel-xyz" });
    expect(process.exitCode).toBe(1);
    // Bun does not reset process.exitCode when assigned `undefined` (unlike Node),
    // so coerce to a numeric 0 to avoid leaking a nonzero exit into the runner.
    process.exitCode = previousExitCode ?? 0;
  });

  test("channels match on an unknown channel emits a clean error without a stack trace", async () => {
    const program = new Command();
    const errors: string[] = [];
    const originalError = console.error;
    const previousExitCode = process.exitCode;
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    try {
      console.error = (value?: unknown) => errors.push(String(value));
      await program.parseAsync(["node", "testapp", "channels", "match", "no-such-channel-xyz"]);
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual(["Channel not found: no-such-channel-xyz"]);
    expect(process.exitCode).toBe(1);
    // Bun does not reset process.exitCode when assigned `undefined` (unlike Node),
    // so coerce to a numeric 0 to avoid leaking a nonzero exit into the runner.
    process.exitCode = previousExitCode ?? 0;
  });

  test("embedded replay supports cursor paging", async () => {
    const program = new Command();
    const output: string[] = [];
    const originalLog = console.log;
    program.exitOverride();
    program.option("-j, --json", "Output JSON");
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.one", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.two", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "-j", "events", "replay", "--dry-run", "--limit", "1"]);
      const firstPage = JSON.parse(output.at(-1) ?? "{}");
      await program.parseAsync(["node", "testapp", "-j", "events", "replay", "--dry-run", "--cursor", firstPage.nextCursor, "--limit", "1"]);
    } finally {
      console.log = originalLog;
    }

    const firstPage = JSON.parse(output.at(-2) ?? "{}");
    const secondPage = JSON.parse(output.at(-1) ?? "{}");
    expect(firstPage.events).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.events).toHaveLength(1);
    expect(secondPage.events[0].id).not.toBe(firstPage.events[0].id);
    expect(secondPage.hasMore).toBe(false);
  });

  test("events list applies a sane built-in default limit when none is configured", () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir });

    const events = program.commands.find((command) => command.name() === "events");
    const list = events?.commands.find((command: { name: () => string }) => command.name() === "list");
    const limitOption = list?.options.find((option: { long?: string }) => option.long === "--limit");

    expect(limitOption).toBeDefined();
    expect(limitOption?.defaultValue).toBe(DEFAULT_EVENT_LIST_LIMIT);
  });

  test("events list caps output to the configured default limit and returns the most recent events", async () => {
    const program = new Command();
    const output: string[] = [];
    const originalLog = console.log;
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir, defaultEventListLimit: 2 });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.one", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.two", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.three", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "list", "-j"]);
    } finally {
      console.log = originalLog;
    }

    const rows = JSON.parse(output.at(-1) ?? "[]");
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { type: string }) => row.type)).toEqual(["testapp.two", "testapp.three"]);
  });

  test("events list --limit 0 lists every recorded event, overriding the default cap", async () => {
    const program = new Command();
    const output: string[] = [];
    const originalLog = console.log;
    program.exitOverride();
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    registerEventsCommands(program, { source: "testapp", dataDir, defaultEventListLimit: 2 });

    try {
      console.log = (value?: unknown) => output.push(String(value));
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.one", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.two", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "emit", "testapp.three", "--no-deliver"]);
      await program.parseAsync(["node", "testapp", "events", "list", "--limit", "0", "-j"]);
    } finally {
      console.log = originalLog;
    }

    const rows = JSON.parse(output.at(-1) ?? "[]");
    expect(rows).toHaveLength(3);
  });
});
