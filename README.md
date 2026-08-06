# @hasna/events

Shared event envelopes, local channels, replay, and delivery transports for Hasna open-source apps.

This package is local-first. By default it stores JSON files under `~/.hasna/events`:

- `channels.json`
- `events.json`
- `deliveries.json`

The CLI `--dir` flag has highest precedence, followed by `HASNA_EVENTS_DIR`,
then the legacy `HASNA_EVENTS_HOME` fallback.

## Storage Runtime Contract

The default compatibility runtime is local JSON files. It does not use local
SQLite, remote Postgres, S3, AWS infrastructure, or live cloud mutation. Apps
that require cross-process idempotency and restart-safe webhook delivery should
use the opt-in durable spool and SQLite broker described below.

```ts
import { getEventsStatus } from "@hasna/events";

const status = await getEventsStatus();

console.log(status.storage);
// {
//   mode: "local-files",
//   localFiles: true,
//   localSqlite: false,
//   remote: false,
//   postgres: false,
//   s3: false,
//   aws: false,
//   idempotency: "best-effort-local",
//   replayCursors: true
// }
```

Cloud-backed stores should implement the same `EventsStore` interface and, for
durable event-bus use, the optional `appendEventOnce` and `listEventsPage`
methods. `appendEventOnce` is the storage-layer hook for atomic idempotency by
`id` or `dedupeKey`, such as a Postgres unique constraint or equivalent
provider guarantee. `listEventsPage` returns an opaque cursor page for bounded
replay. The local JSON store implements these hooks for deterministic local
tests, but its idempotency is best-effort local file behavior, not a
cross-process database lock.

Remote Postgres/S3/AWS adapters should keep credentials and infrastructure
provisioning outside this package configuration, report their storage mode in
`status.storage`, and avoid emitting live external deliveries during store
tests. Creating buckets, databases, secrets, migrations, or production data
changes is an explicit deployment/approval step, not part of this local runtime.

## Install

```bash
bun add @hasna/events
```

The core CLI and durable SQLite broker require Bun 1.0 or newer. The isolated
`@hasna/events/durable-spool` producer export supports Node 20 or newer.

## Event Envelope

All apps should emit the same stable envelope:

```ts
import { EventsClient } from "@hasna/events";

const events = new EventsClient();

await events.emit({
  id: "optional-stable-id",
  source: "tickets",
  type: "ticket.created",
  time: new Date(),
  subject: "ticket:123",
  severity: "notice",
  data: { ticketId: 123 },
  message: "Ticket created",
  dedupeKey: "tickets:ticket:123:created",
  schemaVersion: "1.0",
  metadata: { tenant: "acme" },
});
```

Only `source` and `type` are required inputs. `id` defaults to a UUID, `time`
to the current ISO timestamp, `severity` to `info`, `data` and `metadata` to
empty objects, and `schemaVersion` to `1.0`. `subject`, `message`, and
`dedupeKey` are optional.

`source` should be the emitting app or bounded context. `type` should use dot
notation such as `ticket.created`, `repo.synced`, or `check.failed`. Emission
deduplicates by either an explicit `id` or `dedupeKey` by default; a duplicate
is neither stored nor delivered again. Library callers can pass
`{ dedupe: false }` to store a duplicate intentionally.

## Package Entry Points

The root export includes the client, types, storage, filtering, signing,
transports, and catalog APIs. Focused entry points are also available:

- `@hasna/events/storage`
- `@hasna/events/signing`
- `@hasna/events/filter`
- `@hasna/events/transports`
- `@hasna/events/catalog`
- `@hasna/events/commander`
- `@hasna/events/cli`

## Typed Event Catalog (Distribution Events)

`@hasna/events/catalog` binds well-known envelope `type` strings to the
`@hasna/contracts` schema ids their `data` payloads mirror, and provides an
OPT-IN emit-time validator hook.

Distribution event types (`DISTRIBUTION_EVENT_TYPES`):

| Event type | Contracts schema (`data` mirror) |
| --- | --- |
| `release.published` | `hasna.release.v1` |
| `release.rollout.started` | `hasna.rollout_record.v1` |
| `release.rollout.completed` | `hasna.rollout_record.v1` |
| `release.rollout.failed` | `hasna.rollout_record.v1` |
| `app.installed` | `hasna.rollout_record.v1` |
| `announcement.sent` | `hasna.announcement.v1` |
| `feedback.created` | `hasna.feedback.v1` |
| `feedback.triaged` | `hasna.feedback.v1` |

```ts
import { EventsClient, EventTypeCatalog, registerDistributionEventTypes } from "@hasna/events";

const catalog = registerDistributionEventTypes(new EventTypeCatalog());
const client = new EventsClient({ catalog, validateCatalogTypes: true });

// Registered type with an invalid payload throws EventValidationError
// BEFORE the event is stored or delivered.
await client.emit({
  source: "open-publish",
  type: "release.published",
  data: { appId: "open-todos" },
});
```

Validation is fully backward compatible:

- It is OFF by default (`validateCatalogTypes` defaults to `false`).
- Unregistered/free-form event types ALWAYS pass, even when validation is on.
- A per-emit `validate` option overrides the client setting in both directions.

Payload types (`ReleasePublishedData`, `RolloutData`, `AppInstalledData`,
`AnnouncementSentData`, `FeedbackCreatedData`, `FeedbackTriagedData`) are
dependency-free structural mirrors of the contracts schemas; this package does
not depend on `@hasna/contracts` at runtime.

## OpenAutomations Trigger Ingress

`@hasna/events` is trigger ingress for OpenAutomations. It records and delivers
event envelopes, but it does not own durable automation runs, action queues,
approvals, DLQ state, or replay decisions. `@hasna/automations` consumes the
same envelope shape and materializes matching events into durable automation
runs.

For automation-triggered events:

- set `source` to the emitting app or bounded context
- set `type` with dot notation, such as `ticket.created`
- set `subject` when the event describes one stable domain object
- set `dedupeKey` when the producer has a stable business identity
- keep `id` stable for the specific emitted envelope
- put only serializable trigger data in `data`
- keep secrets out of `data` and `metadata`; pass secret references instead

OpenAutomations derives idempotency from `dedupeKey` first and falls back to
`id` when no dedupe key is present. Replaying events through `events events
replay` re-delivers envelopes; OpenAutomations is still responsible for deciding
whether that delivery creates a new run, returns the existing idempotent run, or
creates an explicit replay request.

## OpenLoops Task Notifications

`@hasna/events` is also notification ingress for OpenLoops task-created routes.
It delivers `todos` envelopes to configured channels, but it does not import
OpenLoops, create workflow invocations, own admission queue state, run agents,
or decide worker retry/backpressure policy. OpenLoops is the consumer that
handles an envelope, dedupes/upserts a work item, admits it when capacity is
available, and records workflow run manifests under `.hasna/loops/runs`.

Replay remains delivery-only. Replaying a `todos.task.created` or
`task.created` envelope sends the event to matching channels again; OpenLoops
decides whether that replay is ignored as an already-admitted task, resumes
existing work, or creates an explicit replay work item.

## Channels And Filters

Channels are reusable notification routes. They can be enabled or disabled,
filtered by source/type/subject/severity, and configured with
transport-specific settings.

```ts
await events.addChannel({
  id: "ops-webhook",
  enabled: true,
  transport: "webhook",
  filters: [{ type: "ticket.*", severity: ["warning", "error", "critical"] }],
  webhook: {
    url: "https://example.com/channels/hasna",
    secret: process.env.HASNA_WEBHOOK_SECRET,
  },
  retry: {
    maxAttempts: 3,
    backoffMs: 500,
    multiplier: 2,
  },
  redact: {
    paths: ["data.token", "metadata.authorization"],
  },
});
```

All matchers inside one filter are ANDed. Multiple filters on a channel are
ORed. A channel with no filters accepts every event, while a disabled channel
accepts none. String matchers support `*` and `**`; `data` and `metadata`
matchers also support nested or literal dotted keys, primitive array-member
matching, typed values, and negative matchers.

## Webhook Transport

Webhook delivery sends a `POST` with the event envelope as JSON.

Headers:

- `Content-Type: application/json`
- `User-Agent: @hasna/events`
- `X-Hasna-Event-Id`
- `X-Hasna-Event-Type`
- `X-Hasna-Timestamp`
- `X-Hasna-Signature` when `webhook.secret` or `webhook.secretRef` resolves

`X-Hasna-Timestamp` is the current delivery-attempt time and is what the HMAC
signs. The envelope `time` in the JSON body remains the original event time, so
delayed imports and retries receive fresh replay-window signatures without
rewriting domain history.
Custom webhook headers whose names begin with `X-Hasna-` are rejected so channel
configuration cannot replace signed delivery metadata.

Signatures use HMAC-SHA256 over:

```text
<timestamp>.<json-body>
```

The signature format is:

```text
sha256=<hex digest>
```

Consumers can verify with:

```ts
import { verifyWebhookSignature } from "@hasna/events/signing";

const ok = verifyWebhookSignature(secret, timestamp, body, signature);
```

`verifyWebhookSignature` rejects timestamps outside a five-minute window by default.
Pass an explicit `toleranceMs` when a consumer needs a tighter or wider replay
window.

## Durable Node Producer And Bun Delivery Worker

`@hasna/events/durable-spool` is the producer boundary for Node 20+ apps. It
has no Bun runtime import and performs no network access. Each enqueue writes a
mode-0600 temporary file, fsyncs it, hard-links it without replacement to an
identity-keyed final name, removes the temporary file, and fsyncs the inbox
directory. Concurrent producers with the same `dedupeKey` converge on one
immutable record.

```ts
import { DurableEventSpool } from "@hasna/events/durable-spool";

const spool = new DurableEventSpool({ dataDir: process.env.HASNA_EVENTS_DIR! });
await spool.enqueue({
  id: "notes:note:123:created",
  source: "notes",
  type: "note.created",
  time: "2026-08-06T12:00:00.000Z",
  subject: "note:123",
  dedupeKey: "notes:note:123:created",
  schemaVersion: "notes.v1",
  data: {
    noteId: "123",
    createdAt: "2026-08-06T12:00:00.000Z",
    originMachine: "station03",
  },
  metadata: {},
});
```

`@hasna/events/durable` is Bun-only because it uses `bun:sqlite`. The broker
imports committed spool records into an event and matching-channel outbox in a
SQLite `BEGIN IMMEDIATE` transaction, then removes the spool record. SQLite WAL,
unique event/dedupe identities, unique event/channel jobs, bounded leases, and
persisted retry timestamps make separate workers and process restarts safe.
Producer spool records and broker event rows apply the default sensitive-key
redaction. Each outbox row additionally applies its channel's `redact.paths`
before the payload is persisted or delivered.

```ts
import { DurableEventsBroker } from "@hasna/events/durable";

const broker = new DurableEventsBroker({ dataDir: process.env.HASNA_EVENTS_DIR! });
broker.addChannel({
  id: "notes-created",
  enabled: false,
  transport: "webhook",
  filters: [{ source: "notes", type: "note.created" }],
  webhook: {
    url: "https://example.com/events/notes",
    secretRef: "env:HASNA_NOTES_WEBHOOK_SECRET",
  },
  retry: { maxAttempts: 5, backoffMs: 1_000, multiplier: 2 },
});

broker.importSpool();
await broker.drain();
broker.close();
```

Durable SQLite channels reject inline `webhook.secret` values. The default
resolver supports `env:VARIABLE_NAME`; callers can inject a vault-backed
resolver. Resolved credential values are used only to sign the in-memory HTTP
request and are never stored in channel configuration, the outbox, delivery
history, or status output.

Any HTTP 2xx response acknowledges delivery. The receiver therefore must return
2xx only after durably enqueueing the event and must deduplicate by `dedupeKey`
or `id`. Non-2xx responses, timeouts, and unresolved runtime secrets follow the
persisted retry schedule. Exhausted jobs remain `dead`; an operator can call
`retryDead({ eventId, channelId, limit })` or use `events durable retry-dead`
without creating a second event/channel outbox identity.

The Bun CLI exposes the same operator boundary:

```bash
events --dir "$HASNA_EVENTS_DIR" durable channel https://example.com/events/notes \
  --id notes-created --source notes --type note.created \
  --secret-ref env:HASNA_NOTES_WEBHOOK_SECRET --disabled

events --dir "$HASNA_EVENTS_DIR" durable drain --limit 100
events --dir "$HASNA_EVENTS_DIR" durable work --limit 100
events --dir "$HASNA_EVENTS_DIR" durable retry-dead --limit 100
events --dir "$HASNA_EVENTS_DIR" durable status
```

`durable drain` imports and processes one bounded batch, then exits. Enqueueing
alone never performs network delivery. `durable work` is the long-running Bun
worker: it watches only the durable spool inbox, debounces file events, imports
and drains immediately, wakes at the next persisted retry timestamp, and runs a
low-frequency bounded reconciliation in case a filesystem notification was
missed. It never watches Apple Notes or note files. SIGTERM and SIGINT stop it
cleanly. Each worker claims only the job it is about to dispatch, and only the
current lease owner can settle it. Delivery is still at-least-once: if a request
outlives its lease, another worker may retry it, so receivers must deduplicate by
`dedupeKey` or `id`. This package change does not install, start, or enable a
runner; a canary deployment must supervise one `durable work` process explicitly.

Webhook requests time out after 15 seconds unless `webhook.timeoutMs` is set.
Non-2xx responses and network failures are recorded as failed attempts. The
compatibility JSON delivery path stores response bodies truncated after 4,096
characters; durable delivery intentionally omits response bodies, stdout, and
stderr from its outbox and delivery history.

## Command Transport

Command channels run a local process and pass the event on stdin and environment variables.
For production task-created automation, route to tested package commands such as
`loops events handle todos-task` rather than long-lived local scripts. Scripts
like `scripts/handle-event.ts` are useful prototypes; repeated behavior should
move into the owning `open-*` package with tests and bounded evidence.

```ts
await events.addChannel({
  id: "local-handler",
  enabled: true,
  transport: "command",
  filters: [{ type: "repo.*" }],
  command: {
    command: "bun",
    args: ["run", "scripts/handle-event.ts"],
  },
});
```

Environment variables:

- `HASNA_CHANNEL_ID`
- `HASNA_EVENT_ID`
- `HASNA_EVENT_TYPE`
- `HASNA_EVENT_SOURCE`
- `HASNA_EVENT_SUBJECT`
- `HASNA_EVENT_SEVERITY`
- `HASNA_EVENT_TIME`
- `HASNA_EVENT_DEDUPE_KEY`
- `HASNA_EVENT_SCHEMA_VERSION`
- `HASNA_EVENT_JSON`

Command processes time out after 15 seconds unless `command.timeoutMs` is set.
Their stdout and stderr are stored on the delivery attempt and truncated after
4,096 characters. A zero exit code succeeds; other exits or signals fail.

Both implemented transports use one attempt by default. Channel retry policy
can increase `maxAttempts`; failed attempts back off from 250 ms by a default
multiplier of 2 unless overridden. The transport type union reserves `email`,
`sse`, and `mcp-relay`, but the CLI refuses to configure them and direct
dispatch currently records them as skipped.

## Redaction

Events scrub obvious sensitive keys such as `secret`, `token`, `password`,
`apiKey`, `api_key`, `api-key`, and `authorization` recursively before local
storage and delivery by default.
Callers that intentionally need raw local payloads can pass:

```ts
await events.emit(input, { redactSensitiveData: false });
```

Use channel-level paths for per-channel delivery redaction:

```ts
await events.addChannel({
  id: "secure-hook",
  enabled: true,
  transport: "webhook",
  webhook: { url: "https://example.com" },
  redact: { paths: ["data.secret", "metadata.token"] },
});
```

Use runtime hooks for app-specific policies:

```ts
const events = new EventsClient({
  redactors: [
    async (event) => ({
      ...event,
      metadata: { ...event.metadata, internalOnly: undefined },
    }),
  ],
});
```

## CLI

The package exposes `events` and `hasna-events`.

Global options must come before the command group:

```bash
events --dir /tmp/events --json status
```

```bash
events channels add https://example.com/channels/hasna \
  --id ops \
  --type "ticket.*" \
  --secret "$HASNA_WEBHOOK_SECRET" \
  --retry-attempts 3 \
  --retry-backoff-ms 500

events channels list
events channels test ops
events channels match ops
events channels remove ops
```

Field filters can match nested `data` or `metadata` values. Plain
`--data`/`--metadata` values are strings, which keeps ids and slugs such as
`001` intact. Use `--data-json` or `--metadata-json` for typed JSON predicates.
Dot paths check both nested object keys and literal dotted keys; there is no
syntax to distinguish between those two forms yet. A negative predicate also
matches when its field is absent.
When the actual event value is an array, string filters match any primitive
array member, which is useful for tag routing such as `data.tags=auto:route`.
Use `path!=value` or `path!=json` for negative predicates such as
`metadata-json 'automation.no_auto!=true'`. Wildcard behavior stays broad for
legacy source/type/subject filters. For field paths ending in `_path` or `.path`,
`*` matches one path segment and `**` matches recursively.

```bash
events channels add loops \
  --id open-source-task-route \
  --transport command \
  --source todos \
  --type task.created \
  --timeout-ms 15000 \
  --retry-attempts 3 \
  --retry-backoff-ms 500 \
  --metadata 'project_path=/home/hasna/workspace/hasna/opensource/*' \
  --metadata-json 'route_enabled=true' \
  --metadata-json 'automation.no_auto!=true' \
  --data 'tags=auto:route' \
  --arg events \
  --arg handle \
  --arg todos-task

# Command args that begin with dashes can be passed either form:
events channels add events --id json-route --transport command --arg --json
events channels add events --id json-route --transport command --arg=--json

# For nested CLIs, put child positional args and flags after an explicit delimiter.
events channels add events --id nested-route --transport command -- handle todos-task --json

events channels match open-source-task-route \
  --source todos \
  --type task.created \
  --metadata '{"project_path":"/home/hasna/workspace/hasna/opensource/open-events","route_enabled":true}'

events channels test open-source-task-route --honor-filters \
  --source todos \
  --type task.created \
  --metadata '{"project_path":"/tmp/outside","route_enabled":true}'
```

Emit, list, and replay:

```bash
events events emit ticket.created \
  --source tickets \
  --subject ticket:123 \
  --severity notice \
  --message "Ticket created" \
  --data '{"ticketId":123}'

events events list --limit 20
events events list --source tickets --type ticket.created
events events replay --type ticket.created
events events replay --type ticket.created --dry-run --limit 100
events events replay --type ticket.created --cursor "$NEXT_CURSOR" --limit 100
events events replay --dry-run
```

Replay cursors are opaque and tied to the same filter set (`--id`, `--source`,
and `--type`) used to produce them. Use the `nextCursor` returned by the
previous JSON replay response rather than constructing cursor strings in
callers. A replay without `--limit` or `--cursor` processes all matching events;
use those flags when callers need bounded page-by-page replay.

Machine-readable status (global flags precede `status`):

```bash
events --json status
```

The status contract reports storage runtime, event, channel, delivery, file, and
transport metadata only. It does not include event payloads, webhook signing
secrets, command environment values, or channel targets.

Use `--json` for script-friendly output and `--dir <path>` for isolated data.
The standalone `events events list` command has no implicit row cap. Commands
registered into another Commander program with `registerEventsCommands` default
to the 100 most recent rows, accept a host override, and use `--limit 0` to list
all rows. The embedded emitter also supports `--no-dedupe`; the standalone CLI
does not currently expose that library option.

## App Integration Pattern

Apps should keep event emission near durable state changes and avoid hardcoding app-specific channels. The common pattern is:

```ts
import { EventsClient } from "@hasna/events";

const events = new EventsClient();

export async function recordDomainEvent() {
  await events.emit({
    source: "your-app",
    type: "domain.object.changed",
    subject: "object:123",
    severity: "info",
    data: { id: 123 },
  });
}
```

Local users and agents can configure channels once through the CLI, and every app using `@hasna/events` will share the same local channel config.

## Development

```bash
bun test
bun run typecheck
bun run build
```
