# Diagnostics privacy contract

Diagnostics must keep Brainstrike's local-first trust boundary: telemetry finds
slow paths and regressions; it never collects user content, workspace identity
or credentials. Applies to background telemetry, diagnostics panels, performance
budgets, regression suites and diagnostic exports unless a narrower
feature-specific contract exists.

## Background telemetry

- Allowed by default:
  - durations, counts, byte sizes
  - process labels, feature names, coarse route or surface identifiers
  - queue depths, retry counts, bounded error categories
  - cache entry counts, eviction reasons, residency durations
- Name metrics after product surfaces, not user data.
  - `file-explorer.expand.duration_ms` is fine; a metric keyed by a local path is not.
- Prohibited by default; avoid collecting at the source, since redaction afterwards is not enough:
  - raw file paths, filenames
  - prompts, file content, source snippets, chunks, generated answers
  - embeddings, raw local database rows
  - provider keys
  - stable hashes of any of the above
- A metric outside the allowed list must document its consent and export path
  before implementation.

## User-initiated export

An export the user explicitly starts may carry richer local state. It must:

- say which data categories are included
- exclude prohibited fields unless the user opts into that category
- prefer summaries, counts and timings over raw records
- offer a local review step before anything leaves the device
- allow deletion and regeneration without a remote service
- stay useful when sensitive categories are omitted

## Data leaving the device

- Requires explicit consent unless it is part of a user-directed network
  operation (e.g. sending the user's prompt to their configured provider).
- Diagnostics upload, support-bundle sharing and remote-telemetry opt-in are
  separate choices from normal app use.
- Consent copy names the categories sent; never hide content- or
  workspace-adjacent fields behind phrases like "usage data".

## Renderer long-task telemetry

Owner: `packages/app-shell/src/diagnostics/renderer-long-task-telemetry.ts`.

- Retains only durations, coarse routes and enabled feature-flag identifiers in a
  bounded, one-minute, memory-only window.
  - Never records attribution data, DOM selectors, paths, filenames or content.
  - Feature flags come only from an injected authoritative registry; without one
    the context is reported as unavailable, never as a fabricated empty list.
- Timing uses one monotonic epoch clock (`performance.timeOrigin + now()`),
  never the wall clock.
  - Module construction is clock-free; a missing or failing clock yields an
    explicit failed snapshot that stays latched, instead of crashing app-shell or
    fabricating timestamps.
  - When an operation and the clock both fail, both causes are kept.
- The store owns expiry and cap eviction, independent of subscribers.
  - Buffered entries use their occurrence time for the window and are
    deduplicated by stable entry identity across observer replay.
  - Malformed entries (negative or non-finite duration, start after delivery,
    completion beyond the 1 ms rounding tolerance) fail collection visibly; valid
    siblings in the same batch are kept.
  - One retention/publication pass per delivered observer batch.
- Buffered samples carry delivery-time route and flag context and are labelled
  as such, not as stall-time attribution.
- Unsupported observation clears retained state and publishes an explicit empty
  window; direct recording afterwards throws.
- Shown in System Diagnostics, discarded with the renderer process: no
  persistence or factory-reset obligation.
