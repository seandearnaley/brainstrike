# @brainstrike/queue-telemetry-collector

Local HTTP collector and CLI for ingesting queue telemetry batches emitted by the Brainstrike embedding queue. It validates incoming payloads, stores them in memory for inspection, and lets operators forward batches to other sinks (files, databases, observability tools) without needing to run the full web app.

## Why This Package Exists

- **Observe queue health locally** – capture queue depth, throughput, and error events from the browser/Electron queues during development.
- **Validate payload contracts** – harden the webhook schema (runtime, events, metadata) before wiring a remote ingestion service.
- **Prototype downstream sinks** – pipe batches into custom analytics or dashboards by providing an `onBatch` callback.

## Installation

```bash
pnpm --filter @brainstrike/queue-telemetry-collector install
```

## CLI Usage

The CLI starts an HTTP server that accepts telemetry batches on `/queue-telemetry` by default.

```bash
pnpm --filter @brainstrike/queue-telemetry-collector start
```

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `QUEUE_TELEMETRY_HOST` | `0.0.0.0` | Host interface to bind. |
| `QUEUE_TELEMETRY_PORT` | `4130` | Listening port. |
| `QUEUE_TELEMETRY_PATH` | `/queue-telemetry` | Request path for incoming batches. |
| `QUEUE_TELEMETRY_API_KEY` | unset | Optional shared secret expected in the `x-api-key` header. |
| `QUEUE_TELEMETRY_MAX_BODY_BYTES` | `256000` | Maximum payload size (bytes). |

Logs report the bound endpoint and whether an API key is required. Press `Ctrl+C` to stop the collector cleanly.

## Programmatic API

```ts
import { createQueueTelemetryCollector } from '@brainstrike/queue-telemetry-collector';

const collector = createQueueTelemetryCollector({
  host: '127.0.0.1',
  port: 0,
  apiKey: 'local-dev',
  onBatch: async (batch) => {
    // Persist or forward events
  },
});

await collector.start();
console.log(collector.getEndpoint());
```

Key methods:

- `nextBatch({ timeoutMs })` – await the next batch (rejects if nothing arrives before the timeout).
- `listBatches()` / `clearBatches()` – inspect or reset the in-memory backlog.
- `isRunning()`, `start()`, `stop()` – manage server lifecycle.

## Testing

Vitest is configured with aliases to source code (no `dist` builds required).

```bash
pnpm --filter @brainstrike/queue-telemetry-collector test
```

The suite exercises all validation branches: method/path enforcement, API key checks, JSON parsing errors, metadata coercion, and timeout handling.

## Building

```bash
pnpm --filter @brainstrike/queue-telemetry-collector run build
```

This cleans `dist/`, compiles TypeScript, and emits ESM ready for publishing or embedding in other tools.
