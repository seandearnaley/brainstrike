# BST-400 Renderer Long-Task Telemetry Plan

## Scope

Add privacy-safe renderer long-task telemetry aligned with
`docs/diagnostics-privacy-contract.md`. This ticket covers main-thread stalls
only; it does not collect paths, filenames, prompts, or database content.

## Requirements

- Observe `longtask` PerformanceObserver entries in the renderer.
- Attach coarse route context (`explorer`, `settings`, `prompts`, `unknown`).
- Attach coarse feature context (active app-shell tab).
- Emit debug-level structured logs via `@brainstrike/utils/logger`.
- Start observation once from `RootLayoutContent` so all app routes are covered.

## Out of Scope

- Uploading telemetry off-device.
- Recording attribution strings, stack traces, or DOM selectors.
- Main-process CPU metrics (BST-401).

## TDD Plan

1. RED: add `renderer-long-task-telemetry.test.ts` covering route normalization,
   coarse metric logging, and observer wiring.
2. GREEN: implement helper + wire into `RootLayoutContent`.
3. Verify: `pnpm --dir packages/app-shell test`, package type-check, root lint/build/test.

## Validation

- Focused Vitest for `packages/app-shell`.
- Manual: run web/desktop dev shell and confirm debug logs on forced long tasks
  (optional; unit tests are the primary gate).
