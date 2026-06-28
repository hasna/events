# @hasna/events

Shared event envelopes, local channels, replay, and delivery transports for Hasna open-source apps.

This package is local-first. By default it stores JSON files under `~/.hasna/events`:

- `channels.json`
- `events.json`
- `deliveries.json`

Override the data directory with `HASNA_EVENTS_DIR`, `HASNA_EVENTS_HOME`, or the CLI `--dir` flag.

## Install

```bash
bun add @hasna/events
```

This package is not published by this repository setup step. Apps can also depend on the local workspace path while the rollout is in progress.

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

Envelope fields are:

- `id`
- `source`
- `type`
- `time`
- `subject`
- `severity`
- `data`
- `message`
- `dedupeKey`
- `schemaVersion`
- `metadata`

`source` should be the emitting app or bounded context. `type` should use dot notation such as `ticket.created`, `repo.synced`, or `check.failed`.

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

Filters support `*` wildcards and nested `data` or `metadata` paths.

## Webhook Transport

Webhook delivery sends a `POST` with the event envelope as JSON.

Headers:

- `X-Hasna-Event-Id`
- `X-Hasna-Event-Type`
- `X-Hasna-Timestamp`
- `X-Hasna-Signature` when `webhook.secret` is configured

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

The transport type union already reserves `email`, `sse`, and `mcp-relay` for later implementations.

## Redaction

Events scrub obvious sensitive keys such as `secret`, `token`, `password`,
`apiKey`, and `authorization` before local storage and delivery by default.
Callers that intentionally need raw local payloads can pass:

```ts
await events.emit(input, { redactSensitiveData: false });
```

Use channel-level paths for config-only redaction:

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

```bash
events channels add https://example.com/channels/hasna \
  --id ops \
  --type "ticket.*" \
  --secret "$HASNA_WEBHOOK_SECRET" \
  --retry-attempts 3 \
  --retry-backoff-ms 500

events channels list
events channels test ops
events channels remove ops
```

Field filters can match nested `data` or `metadata` values. Plain
`--data`/`--metadata` values are strings, which keeps ids and slugs such as
`001` intact. Use `--data-json` or `--metadata-json` for typed JSON predicates.
Dot paths access nested object keys; dots inside key names are not escaped yet.
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
events events replay --type ticket.created
events events replay --dry-run
```

Machine-readable status:

```bash
events status --json
```

The status contract reports event, channel, delivery, file, and transport counts
only. It does not include event payloads, webhook signing secrets, command
environment values, or channel targets.

Use `--json` for script-friendly output and `--dir <path>` for isolated data.

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
