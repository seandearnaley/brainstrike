# Threads-panel active-run projection — evidence

Supports `docs/agents/assistant-persistence.md` §
"Threads-panel active-run projection". Read this before proposing to change the single live query, the web boot sweep, or the failure surface.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

The Threads panel derives its running indicators directly from
`brainstrike_assistant_thread_runs` through ONE resource-scoped PGlite live
query (`packages/app-shell/src/use-active-assistant-thread-ids.ts`). It does not
own a second activity store, poll, or subscribe once per row. The query selects
the distinct thread ids whose durable status is `running`; the virtualized row
surface only performs `Set.has(thread.id)` for visible rows.

This makes all existing lifecycle writers authoritative for the indicator:
renderer-created runs appear after their durable insert; completed, failed, and
cancelled runs clear after their terminal update; thread deletion clears via
the existing cascade; and startup orphan sweeps clear pre-boot crash rows
through the same status transition. Desktop runs the sweep in main before the
renderer can create work. Web has no surviving run owner across reloads, so the
Threads-panel projection runs the shared boot-time predicate after schema
bootstrap and before starting its live query. It uses the navigation time
origin, not hook mount time, so opening or remounting the panel cannot classify
a current-page long run as an orphan. Desktop skips the renderer sweep because
its main-process stream can survive a renderer reload and reattach.

Once schema bootstrap has succeeded for a database handle, the subscription
stays enabled across transient thread-list loading states (including thread
creation) and only resets when the handle changes. Sweep, subscription, or
row-shape failures clear possibly stale indicators and render an explicit
unavailable state instead of silently presenting every thread as idle. The
spinner is a labelled graphic rather than a live region, avoiding repeated
screen-reader announcements as virtualized rows mount, and keeps a static
active treatment under reduced motion.

Paired coverage: `packages/app-shell/src/__tests__/threads-panel.test.tsx` and
the concurrent-run case in `apps/web/e2e/assistant-ui-panel.test.ts`.

**2026-09-28 (BST-1850).** The per-database web startup reap store moved out of `use-active-assistant-thread-ids.ts` into `web-startup-reap.ts` (no behaviour change; its log scope is now `WebStartupReap`). The app reload gate (`app-reload/use-running-assistant-runs.ts`) is its second consumer and counts running rows across every resource and starts the reap only behind the same thread-store readiness (`schemaReady`) and once a reload is required; see `ui-conventions/app-reload.md`.
