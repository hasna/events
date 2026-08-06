import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { redactSensitiveKeys } from "./redaction.js";
import type { EventEnvelope, EventInput } from "./types.js";

export interface DurableEventSpoolOptions {
  dataDir: string;
}

export interface DurableSpoolEnqueueResult<TData extends Record<string, unknown> = Record<string, unknown>> {
  event: EventEnvelope<TData>;
  stored: boolean;
  deduped: boolean;
}

export interface DurableSpoolRecoveryOptions {
  olderThanMs?: number;
}

export interface DurableSpoolRecoveryResult {
  recovered: number;
  deduped: number;
  cleaned: number;
}

export class DurableEventSpool {
  readonly dataDir: string;
  readonly inboxDir: string;

  constructor(options: DurableEventSpoolOptions) {
    if (!options.dataDir) throw new Error("DurableEventSpool requires dataDir");
    this.dataDir = options.dataDir;
    this.inboxDir = join(options.dataDir, "spool", "inbox");
  }

  async enqueue<TData extends Record<string, unknown>>(
    input: EventInput<TData>,
  ): Promise<DurableSpoolEnqueueResult<TData>> {
    const event = redactSensitiveKeys(createSpoolEvent(input));
    await this.ensureInbox();
    const finalPath = this.pathFor(event);
    const tempPath = join(this.inboxDir, `.tmp-${process.pid}-${randomUUID()}`);
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    let stored = false;
    try {
      await link(tempPath, finalPath);
      stored = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
      await this.assertSameIdentity(finalPath, event);
    }
    await unlink(tempPath);
    await this.syncInbox();
    return { event, stored, deduped: !stored };
  }

  async recover(options: DurableSpoolRecoveryOptions = {}): Promise<DurableSpoolRecoveryResult> {
    await this.ensureInbox();
    const olderThanMs = Math.max(0, options.olderThanMs ?? 60_000);
    const threshold = Date.now() - olderThanMs;
    const result: DurableSpoolRecoveryResult = { recovered: 0, deduped: 0, cleaned: 0 };
    const names = (await readdir(this.inboxDir)).filter((name) => name.startsWith(".tmp-")).sort();
    for (const name of names) {
      const tempPath = join(this.inboxDir, name);
      const details = await stat(tempPath).catch(() => undefined);
      if (!details || details.mtimeMs > threshold) continue;
      let event: EventEnvelope | undefined;
      try {
        event = parseEnvelope(await readFile(tempPath, "utf8"));
      } catch {
        await unlink(tempPath).catch(() => undefined);
        result.cleaned += 1;
        continue;
      }
      const finalPath = this.pathFor(event);
      try {
        await link(tempPath, finalPath);
        result.recovered += 1;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.assertSameIdentity(finalPath, event);
        result.deduped += 1;
      }
      await unlink(tempPath).catch(() => undefined);
    }
    if (result.recovered || result.deduped || result.cleaned) await this.syncInbox();
    return result;
  }

  async close(): Promise<void> {
    // The spool owns no long-lived descriptors. This method keeps the Node and
    // Bun producer lifecycle APIs symmetrical.
  }

  private pathFor(event: Pick<EventEnvelope, "id" | "dedupeKey">): string {
    const identity = event.dedupeKey ?? event.id;
    const digest = createHash("sha256").update(identity, "utf8").digest("hex");
    return join(this.inboxDir, `${digest}.json`);
  }

  private async assertSameIdentity(path: string, event: Pick<EventEnvelope, "id" | "dedupeKey">): Promise<void> {
    const existing = parseEnvelope(await readFile(path, "utf8"));
    const matches = existing.id === event.id || (
      event.dedupeKey !== undefined && existing.dedupeKey === event.dedupeKey
    );
    if (!matches) throw new Error("Durable spool identity collision");
  }

  private async ensureInbox(): Promise<void> {
    const spoolDir = join(this.dataDir, "spool");
    await mkdir(this.inboxDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    await chmod(spoolDir, 0o700);
    await chmod(this.inboxDir, 0o700);
    await this.syncDirectory(this.dataDir);
    await this.syncDirectory(spoolDir);
  }

  private async syncInbox(): Promise<void> {
    await this.syncDirectory(this.inboxDir);
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function createSpoolEvent<TData extends Record<string, unknown>>(input: EventInput<TData>): EventEnvelope<TData> {
  return {
    id: input.id ?? randomUUID(),
    source: input.source,
    type: input.type,
    time: input.time instanceof Date ? input.time.toISOString() : input.time ?? new Date().toISOString(),
    subject: input.subject,
    severity: input.severity ?? "info",
    data: input.data ?? ({} as TData),
    message: input.message,
    dedupeKey: input.dedupeKey,
    schemaVersion: input.schemaVersion ?? "1.0",
    metadata: input.metadata ?? {},
  };
}

function parseEnvelope(raw: string): EventEnvelope {
  const value = JSON.parse(raw) as Partial<EventEnvelope>;
  if (!value || typeof value !== "object") throw new Error("Invalid durable event spool record");
  for (const field of ["id", "source", "type", "time", "schemaVersion"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error("Invalid durable event spool record");
    }
  }
  if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
    throw new Error("Invalid durable event spool record");
  }
  if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) {
    throw new Error("Invalid durable event spool record");
  }
  return value as EventEnvelope;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
