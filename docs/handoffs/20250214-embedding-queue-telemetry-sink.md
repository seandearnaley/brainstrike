# Embedding Queue Telemetry Sink Rollout (2025-02-14)

## Overview
- Added `initializeQueueTelemetrySink` batching to `@brainstrike/queue` with retry-safe HTTP delivery and Beacon fallback.
- Web and desktop renderers opt-in via `VITE_QUEUE_TELEMETRY_ENDPOINT`/`VITE_QUEUE_TELEMETRY_API_KEY`; sink sleeps when unset or `NODE_ENV=test`.
- Vector HUD now surfaces throughput, latency (avg/p50/p95), and 1-minute error counts; queue counts reuse provider metrics.
- Import progress modal listens for `brainstrike:queue-progress` events to display pending/processed/failed totals alongside the active chunk.

## Remote Sink Details
- Default window is 5 s or 20 events; each payload posts JSON:
  ```json
  {
    "runtime": "browser",
    "sentAt": "2025-02-14T19:05:00.000Z",
    "metadata": { "app": "web", "mode": "development" },
    "events": [
      {
        "timestamp": 1739550300000,
        "adapter": "workerpool",
        "event": "complete",
        "taskId": "chunk-123",
        "model": "text-embedding-3-small",
        "elapsedMs": 118,
        "pending": 2
      }
    ]
  }
  ```
- Use `initializeQueueTelemetrySink({ endpoint, apiKey, metadata })` directly if you need Node/Electron-main coverage.
- Sink disables itself when `fetch` is unavailable; failed deliveries requeue events and log a warning through `EmbeddingQueueTelemetrySink` logger.

## UI & Event Contracts
- `packages/vector-management/src/vector-status.tsx` now formats jobs/min, completed counts, and latency Avg/P50/P95 using telemetry snapshots.
- `packages/file-import/src/browser-queue-port.ts` dispatches `brainstrike:queue-progress` with `{ pending, processed, failed, totalQueued, lastError, lastEvent }` on queue transitions.
- `packages/db-explorer/src/enhanced-file-import-service.ts` subscribes to that event and stores progress in `EnhancedImportProgress.queueProgress`, rendered by `ImportProgressDisplay`.

## Follow-Ups
1. Deploy ingestion target (Datadog/log stream/serverless) and wire secrets for `VITE_QUEUE_TELEMETRY_ENDPOINT` / API keys.
2. Stream collected metrics into dashboards and consider trendlines or sparklines in the HUD once historical data exists.
3. Extend import UI with per-file badges/toasts fed by `brainstrike:queue-progress` and surface last error externally.
4. Add Playwright coverage for import -> queue -> completion flows using the new queue progress events.
5. Update ops/onboarding docs once the collector and dashboards are in place.

## Verification
- `pnpm --filter @brainstrike/queue test`
- `pnpm --filter @brainstrike/vector-management test`
- `pnpm --filter @brainstrike/file-import test`
