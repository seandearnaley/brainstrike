# Embedding telemetry diagnostics (BST-1101) — evidence

Supports `docs/agents/local-inference.md` § "Embedding telemetry diagnostics".
Read before changing what the System Diagnostics embedding card renders, or the
meaning of `peakVectorsInFlight` in streaming versus workerpool mode.

## Original text


- The System Diagnostics embedding card presents aggregate transfer, residency,
  memory-estimate, device-count, and health-count data only. It must not render cache
  keys, model names, source ids, failure strings, user content, or vectors. An empty
  observation window is neutral (`No samples`), not a warning or degraded state. A
  desktop telemetry-provider failure renders a fixed unavailable message; its raw
  error text remains internal and must not reach the diagnostics DOM.
- `EmbeddingTelemetrySnapshot.peakVectorsInFlight` is a per-batch high-water mark.
  In streaming mode it is the largest batch waiting for acknowledgement; the worker
  waits for that acknowledgement before sending the next batch. In workerpool mode the
  adapter emits one synthetic batch for the complete task result, so the value is the
  largest vector count returned by one task, not the total concurrent vectors across
  the pool. Multi-source aggregation takes the maximum and never sums source peaks.
- `resetEmbeddingTelemetryForTests` is deliberately excluded from the production root
  API. Tests that need process-global telemetry isolation import the explicit
  `@brainstrike/embedding-worker/testing` subpath. Production code must never import it.
- App-shell tests use the production snapshot validator and empty-snapshot factory from
  `@brainstrike/embedding-worker`; a permissive shape-only mock would hide desktop host
  boundary failures.
