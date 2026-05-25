# BST-403 DB Query Histogram Telemetry Plan

## Scope

Add privacy-safe DB query duration histograms grouped by coarse feature area, as
listed in `docs/diagnostics-privacy-contract.md` (BST-403).

## Requirements

- Record scheduler-completed database work durations only (no SQL text or params).
- Normalize scheduler labels into coarse feature areas (`live-query`, `sync`,
  `transaction`, `collection-indexing`, `unknown`).
- Emit debug logs via `recordDbQueryTelemetry`.
- Provide an in-memory histogram aggregator for diagnostics/tests.

## Integration

Hook `DatabaseWorkScheduler.#recordTaskCompleted` so every scheduled query records
telemetry after service duration is measured.

## TDD

1. RED: `db-query-telemetry.test.ts` for label normalization, coarse logging, histograms.
2. GREEN: implement helper + scheduler hook.
3. Verify package tests and type-check.

## Out of Scope

- Remote upload of histograms.
- SQL statement logging or parameter capture.
