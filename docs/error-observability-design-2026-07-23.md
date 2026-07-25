# Error Observability & Debug Bundles ("Flight Recorder") — Design

> 2026-07-23. Status: P1 + debug bundle + P2a (NDJSON backstop, persistent Log Viewer) + P2b (status chip, retention settings, sink-health banner) IMPLEMENTED; P3 / P5 pending. Companion presentation:
> `docs/error-observability-presentation-2026-07-23.html`.
>
> Problem owner: Sean. Motivating pain: as model/provider support grows, threads
> fail in ways that are expensive to reproduce. We need (1) durable capture of
> errors/warnings — including background and after-close, (2) a one-click "copy
> debug bundle" on a failed thread that an LLM agent can fix from directly, and
> (3) a way for agents to discover problems without re-running the app.

---

## 1. Current state (verified against code, 2026-07-23)

What already exists and is reusable:

| Layer | What exists | Where |
| --- | --- | --- |
| Logger | Pino v10 singleton; levels, scoped loggers, 2-layer redaction, `addLogListener` fan-out seam | `packages/utils/src/logger.ts` |
| In-memory buffers | `LogBuffer` ring buffers: web 500 records, desktop main 3000 | `packages/utils/src/log-buffer.ts`, `apps/web/src/log-buffer.ts`, `apps/desktop/src/main.ts` |
| Desktop file log | Single append-only `${logs}/brainstrike.log` (pino/file), no rotation | `apps/desktop/src/main.ts` (`getLogFilePath`) |
| Renderer error hooks | `window.onerror` + `unhandledrejection` → logger (transient) | `packages/utils/src/logging/install-renderer-error-hooks.ts` |
| Log forwarding IPC | `logging:get-buffered-logs`, `logging:ingest-buffered-record`, `logging:select-destination`, `logging:open-destination` | `apps/desktop/src/platform/logging-api-contract.ts`, `logging-ipc.ts` |
| Run persistence | `brainstrike_assistant_thread_runs` (status + free-text `error`), `_run_events` (sanitized timeline), `_run_usage` (tokens/cost), `_run_outcomes` (verdicts), `_edit_checkpoints`, `_tool_output_artifacts` | `packages/app-shell/src/assistant-memory-repository.ts` + migrations 046–069 |
| Error classification | `MastraAgentError` (code/context/cause), `resolveProviderError` / `makeProviderErrorTermination`, `StreamStalledError`, guard/`GuardedToolError`, retry processors | `packages/agent/src/mastra/*`, `packages/agent/src/stream/*`, `packages/agent/src/tools/guard-tool-execution.ts` |
| Diagnostics | Crash-recovery snapshot (in-memory), `desktop-diagnostics:get-snapshot`, `db:diagnostics`, System Diagnostics panel, settings Log Viewer (`LogSourceAdapter`) with Export | `apps/desktop/src/ipc-desktop-diagnostics.ts`, `packages/app-shell/src/diagnostics/`, `packages/preferences/.../log-viewer-components/` |
| Clipboard | `clipboard:write-text` IPC already bridged | `apps/desktop/src/preload.ts` |

### The gaps (what this design adds)

1. **No durable, queryable error store.** Logs die with the process (web) or land
   in one unrotated flat file (desktop). The Log Viewer only shows the in-memory
   buffer. Nothing survives "close the app, come back tomorrow, what went wrong?"
2. **Structured errors are flattened.** `MastraAgentError.code`, `.context`, and
   the `cause` chain reduce to one free-text string in `thread_runs.error`.
   Watchdog stalls, guard codes, and retry classifications are not queryable.
3. **Provider forensics are discarded.** Request ids, `ratelimit-*` /
   `retry-after` headers, HTTP status, and raw error envelopes are read
   transiently (for backoff) then dropped. These are the highest-value fields
   for diagnosing per-provider flakiness.
4. **Background/invisible failures.** Hidden-host errors, `render-process-gone`,
   `uncaughtException`, embedding-queue errors: logged transiently, never
   persisted; crash-recovery snapshot resets on restart.
5. **No correlation model.** No session id ties multi-process events to a run;
   diagnostics snapshots aren't associated with failures.
6. **No export bundle.** Nothing assembles run + timeline + errors + transcript +
   environment into something you can paste into an LLM.

---

## 2. Goals / non-goals

**Goals**
- G1. Durable error/warning log, local-first, surviving app close — desktop AND web.
- G2. One-click **Copy debug bundle** on any failed thread/run: complete, bounded,
  redacted, LLM-ready Markdown.
- G3. Durable **text-based error log file** on desktop (greppable by external
  agents like Claude Code without launching the app).
- G4. Background capture: main process, hidden hosts, workers, renderer crashes.
- G5. Agent self-service: the in-app assistant can query the error log (native
  tool), so it can diagnose without re-running from scratch.
- G6. Structured run-error enrichment: stable codes, cause chains, provider
  request ids/headers, retry timeline.

**Non-goals (explicit)**
- No external telemetry service (Sentry, etc.) — conflicts with local-first and
  the privacy wedge. Everything stays on the client.
- No capture of raw provider request payloads by default (privacy + size). A
  future opt-in "deep capture" flag can add it; out of scope here.
- No change to the assistant hot path's latency profile (writes are async,
  batched, and never awaited on the stream path).
- Not replacing `assistant_run_events` — it stays the per-run timeline; the new
  store is cross-cutting (app-wide) with different retention.

---

## 3. Approaches considered

**A. DB-first: new PGlite table + desktop NDJSON mirror (RECOMMENDED).**
One `brainstrike_diagnostic_events` table written from all processes via the
existing DB bridge; desktop additionally mirrors warn+ records to a rotating
NDJSON file. Queryable (SQL, live queries, fingerprint grouping — plays to "the
database is the moat"), works identically on web, and the file mirror covers
the case the DB sink structurally cannot: *the database itself is broken*.

**B. File-first: structured rotating logs only, no table.**
Simplest, but web gets nothing durable (no FS), nothing is queryable (no
grouping, no "top errors this week", no agent tool without parsing files), and
bundle assembly means re-parsing text. Rejected as primary; kept as the desktop
mirror in A.

**C. Extend `assistant_run_events` to be the app-wide store.**
Tempting reuse, but it is run-scoped by schema (FK to runs/threads), its
metadata sanitizer deliberately strips bodies, and its retention semantics are
conversation-lifetime. Wedging app-wide warnings into it muddies a settled
contract. Rejected (the run-events doc marks its scope "do not relitigate").

**Decision: A.** DB is the single queryable source of truth; the desktop file is
an honest backstop and the "durable text log" Sean asked for.

---

## 4. Architecture

```
 capture sources                    sinks                       consumers
 ───────────────                    ─────                       ─────────
 logger warn/error/fatal ┐
 renderer error hooks    │   ┌─> DiagnosticEventWriter ──> brainstrike_diagnostic_events (PGlite)
 error boundaries        ├───┤      (batch, bounded,          │  ├─ Log Viewer "Persistent" source
 uncaughtException /     │   │       redacted,                │  ├─ debug-bundle builder
 unhandledRejection      │   │       loop-guarded)            │  ├─ brainstrike.queryDiagnostics tool
 render-process-gone     │   │                                │  └─ fingerprint analytics
 run.failed / tool.failed│   └─> desktop NDJSON mirror        │
 stream/guard/watchdog   ┘        ${logs}/brainstrike-errors.ndjson (rotating)
                                   (main-process only; renderers forward
                                    via existing logging IPC)
```

### 4.1 Capture: one seam, many sources

Everything funnels through the existing `addLogListener` fan-out on the Pino
logger — we do **not** invent a second event API. Sources that don't already log
get wired to log structurally:

- **Renderer error hooks** already call `logger.error` — no change.
- **`ErrorBoundary.componentDidCatch`** gains a default `logger.error` (today it
  only calls the optional `onError` prop) with `componentStack` in context.
- **Main process**: `uncaughtException`/`unhandledRejection` already log;
  `render-process-gone` handlers already log — no change beyond making their
  metadata structured (`code`, `windowRole`, `exitCode`).
- **Assistant runtime**: `makeProviderErrorTermination`, watchdog expiry, guard
  failures, and each `StreamErrorRetryProcessor` retry attempt log one
  structured record with a stable `code` (most already do; this normalizes the
  metadata shape — see §6).
- **Queue telemetry**: a tiny adapter subscribes `addQueueTelemetryListener` and
  logs `error`-type queue events (today they're in-memory only).

The listener-side filter is `level >= WARN` (configurable). INFO/DEBUG stay
where they are today (console + desktop flat file + in-memory buffer) —
the durable store is for *problems*, not a full trace archive.

### 4.2 The table

New migration (registered in **both** runners, per the database contract) +
bootstrap SQL alongside the assistant tables:

```sql
CREATE TABLE IF NOT EXISTS brainstrike_diagnostic_events (
  id            UUID PRIMARY KEY,                    -- uuidv7 (time-ordered)
  occurred_at   TIMESTAMPTZ NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('warn','error','fatal')),
  source        TEXT NOT NULL,   -- 'electron-main'|'desktop-renderer'|'web-renderer'
                                 -- |'embedding-host'|'llm-host'|'chunking-host'|'db-worker'
  scope         TEXT,            -- logger scope, e.g. 'DesktopMain', 'FileImporter'
  code          TEXT,            -- stable machine code when known (see §6 taxonomy)
  message       TEXT NOT NULL,   -- bounded 2_000 chars
  stack         TEXT,            -- bounded 8_000 chars
  cause_chain   JSONB,           -- [{name, message, code?}] walked from Error.cause
  context       JSONB,           -- redacted structured metadata (bounded 8_000 serialized)
  fingerprint   TEXT NOT NULL,   -- md5(code ?? scope ?? '' || normalized message)
  session_id    TEXT NOT NULL,   -- per-process-launch uuid (see §4.4)
  run_id        TEXT, thread_id TEXT, resource_id TEXT, root_id TEXT,  -- nullable correlation
  app_version   TEXT NOT NULL,
  platform      TEXT NOT NULL    -- 'darwin-arm64' | 'web-chrome' | ...
);
CREATE INDEX ... occurred_at DESC;
CREATE INDEX ... (fingerprint, occurred_at DESC);
CREATE INDEX ... (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX ... (severity, occurred_at DESC);
```

Deliberate choices:
- **No FKs** (run_usage/run_outcomes precedent — the numbered runner sees a bare
  schema; orphans are inert).
- **Fingerprint at write time** (code + scope + message with digits/uuids/paths
  normalized out) so grouping is a `GROUP BY`, not a runtime clustering job.
  This is what powers "this exact failure happened 14× this week, all on
  openrouter/qwen3" and the bundle's *Prior related failures* section.
- **Bounds are enforced at write** with explicit truncation markers — oversized
  context is truncated *visibly* (`"…[truncated 12,340 chars]"`), never silently
  (no-silent-fallbacks applies to elision too).
- **Retention**: bounded oldest-first purge (tool-output-artifact precedent) on
  writer start + every N inserts: `max(30 days, 20_000 rows)` — both
  user-configurable in settings. Purge is a bounded batch, never `DELETE` without
  a limit.
- **Factory reset**: added to both direct-PGlite reset and desktop `db:clearAll`
  (platform contract), and to the `db-test-lane-manifest.mjs` regex for its tests.

### 4.3 The writer (`DiagnosticEventWriter`)

One small module in `packages/utils` (interface) + platform bindings:

- **Batching**: queue up to 256 pending; flush every 2s or at 32 events,
  `visibilitychange:hidden` and `beforeunload` force a flush (web's
  "survives close" story); desktop main flushes on graceful shutdown.
- **Backpressure, loud**: overflow drops oldest and increments a counter that is
  itself emitted as a `diagnostics_events_dropped` event on the next successful
  flush — we never silently lose loss.
- **Loop guard**: records originating from the writer/DB layer (scope tag) are
  routed **only** to the file mirror/console, never back into the DB sink. If a
  flush fails N consecutive times, the DB sink disables itself for the session
  and raises a visible Log Viewer banner + one file-mirror record — honest
  degradation, not recursion.
- **Corruption interplay**: the writer subscribes to the DB-corruption-recovery
  generation (platform contract §recovery). Pending events buffer through
  recovery and flush into the replacement DB; the corruption error itself goes to
  the file mirror (desktop) — which is exactly why the mirror exists.
- **Who writes**: renderers write via the existing repository/DB bridge
  (renderer-direct, Path A — same as run ledger); hidden hosts and main-process
  code forward records over the existing `logging:ingest-buffered-record`
  channel to main, which owns a single writer per process tree on desktop. Web
  has exactly one writer in the visible renderer + workers forwarding via
  `postMessage` (the queue-telemetry pattern).
- **Eager flush for high severity**: `error`/`fatal` events bypass the batch
  window entirely — the writer flushes immediately (single-flight, so this is
  cheap even under bursts) instead of waiting for the 2s timer or the 32-event
  threshold. `warn` events still batch normally. Rationale: browsers do not
  guarantee that async work started inside a `visibilitychange:hidden` handler
  actually completes before the page is torn down, so anything above `warn`
  cannot be allowed to sit in the batch window waiting for that handler to fire.
- **Web close-durability is best-effort, not guaranteed**: even with the
  `visibilitychange:hidden` flush and the eager high-severity flush above, web
  has no durable backstop equivalent to desktop's file mirror. Stated worst
  case: a batch of `warn` events sitting inside the 2s flush window can be lost
  if the tab is killed (not just hidden) mid-flush — e.g. OS-level process kill,
  browser crash, or force-quit before the in-flight `insertBatch` call
  resolves. Desktop's file backstop (§7) covers the equivalent failure mode
  once the P2 NDJSON sink lands; web has no equivalent today and this is an
  accepted gap, not an oversight.

### 4.4 Correlation model

- `session_id`: uuid minted once per process launch at `initializeLogging`,
  stamped into logger `baseBindings` so every record carries it for free;
  renderer sessions also carry the main session id on desktop
  (`{sessionId, parentSessionId}`) so one incident can be stitched across
  processes.
- `run_id`/`thread_id`: the assistant runtime already threads these; capture
  points inside the stream path attach them to the log metadata (a
  `withRunLogContext` helper wrapping the existing scoped logger, mirroring how
  correlation ids already appear in desktop init-failure logs).
- Environment (`app_version`, `platform`) denormalized onto every row — rows
  must stay meaningful after the app updates.

---

## 5. Debug bundle ("Copy debug info")

### 5.1 UX

- **Placement**: an action in the failed-message error block
  (`assistant-message-error.tsx`) and in the message action bar next to
  Retry/Regenerate (`assistant-ui-panel.tsx` ~L1776); plus thread context menu →
  "Copy debug bundle" (works even when the failure isn't the last message).
- **Actions**: `Copy` (existing `clipboard:write-text` on desktop,
  `navigator.clipboard` on web) and `Save…` (desktop: `logging:select-destination`
  pattern; web: Blob download). Both show the bundle size before/after copy
  ("Copied debug bundle — 84 KB").
- Capability-gated composition (no `isElectron()`): the builder lives in
  app-shell and takes optional desktop-only snapshot providers; web simply
  omits them and the bundle says so honestly.

### 5.2 Builder

`buildThreadDebugBundle({threadId, runId?})` in
`packages/app-shell/src/diagnostics/debug-bundle.ts`. Pure assembly over
existing + new stores, joined by `run_id`/`thread_id`:

| Section | Source |
| --- | --- |
| 1. Failure summary — status, code, message, cause chain, provider/model, timings | `thread_runs` + new `run_errors` (§6) |
| 2. Run configuration — model_settings, provider_options, runtime_kind, enabled native tools, MCP servers (names only) | `thread_runs` jsonb + request prefs |
| 3. Run timeline — ordered run events w/ durations, tool.started/failed, hook notices | `run_events` |
| 4. Resilience history — retry attempts, backoff, watchdog, processor decisions | new `run_errors.attempts` (§6) |
| 5. Correlated diagnostic events — warn+ rows for this run/thread ± 5 min window (catches background noise around the failure) | `diagnostic_events` |
| 6. Transcript — messages incl. tool-call args/results, bounded per-part with visible elision, redacted | `mastra_messages` (+ `tool_output_artifacts` refs, not bodies) |
| 7. Usage & cost | `run_usage` |
| 8. Environment — app version, OS/arch, DB diagnostics snapshot, crash-recovery snapshot (desktop) | diagnostics IPC (desktop) / honest omission (web) |
| 9. Prior related failures — same fingerprint, last 7 days, count + first/last seen | `diagnostic_events` GROUP BY fingerprint |

Format: **one Markdown document**, `bundle_format: 1` header, sections in fixed
order, JSON blocks fenced — optimized for pasting into an LLM (headers give the
model an index; fixed order lets prompts reference sections by number).

Bounds: default 200 KB target. Deterministic elision order when over budget:
old transcript turns first (keep the failing turn ± 2), then tool result bodies
(keep args + error text), then timeline detail. Every elision leaves a visible
marker with counts. Redaction reuses `redactSensitiveLogValue` + the logger key
set over the whole bundle as a final pass (belt and braces — sources are
already redacted).

### 5.3 Why this fixes the "run again and again" loop

Sections 3–5 and 9 are the ones agents can't get today at any price: the exact
terminal code, what the retry layer already tried, what else was going wrong in
the app at that moment, and whether this is a one-off or the 14th occurrence.
Sections 1–2 + 6 mean the agent doesn't need the app open at all to reason
about the failure.

---

## 6. Structured run-error enrichment

New FK-less sibling table (run_usage precedent), written once per failed run at
the existing choke points (`makeProviderErrorTermination`, watchdog expiry,
guard terminal, desktop init failures):

```
brainstrike_assistant_run_errors
  run_id PK, thread_id, resource_id,
  code TEXT NOT NULL,            -- MastraAgentError code / terminal code vocab
  message TEXT,                  -- bounded
  cause_chain JSONB,
  http_status INT,
  provider_request_id TEXT,      -- x-request-id / request-id when present
  response_headers JSONB,        -- WHITELISTED: ratelimit-*, retry-after, x-request-id
  attempts JSONB,                -- [{n, at, classification, waitedMs}] from retry processor
  occurred_at TIMESTAMPTZ
```

Header capture: a per-provider `fetch` wrapper in `provider-factory.ts` records
the **whitelisted** response headers + status of the most recent response per
request context (the prompt-caching wrapper precedent shows per-provider
wrapping is already idiomatic there). Nothing outside the whitelist is stored;
bodies are never stored. `thread_runs.error` stays as-is for back-compat; the
UI error block can now show "code + request id" with a copy affordance.

**Conflict rule (multiple terminal choke points, one run):** more than one of
`makeProviderErrorTermination`, watchdog expiry, and guard terminal can fire
for the same `run_id` (e.g. the watchdog expires the same tick a provider
error terminates the stream). The writer is an **UPSERT keyed on `run_id`**
with **first-terminal-wins** semantics for the classification fields (`code`,
`message`, `cause_chain`, `http_status`, `provider_request_id`,
`response_headers`, `occurred_at`) — whichever choke point writes first owns
the row's classification; later writers for the same `run_id` do **not**
overwrite those fields. Later writers **merge only `attempts`** (append their
attempt entries to the existing `attempts` array) so the resilience-history
timeline stays complete even though the classification is stable. Stated
invariant: **a run's `run_errors` row never changes its `code` after the first
write.** This requires a test: two choke points racing on the same `run_id`
must leave the first writer's classification fields intact while both
writers' `attempts` entries are present in the merged array.

This is the single highest-leverage schema change for multi-provider debugging:
provider support tickets start with "what's the request id".

---

## 7. Desktop durable text log (G3)

- Switch the existing file transport line format to **NDJSON** and add a second
  file sink: `${logs}/brainstrike-errors.ndjson` at `warn+`, size-rotated
  (10 MB × 5 files). **Correction from an earlier draft of this doc**: `pino`
  and `pino/file` alone cannot rotate — `pino/file` is a plain append-only
  destination stream with no size-check-and-rotate logic built in. Size
  rotation needs either a real rotating transport (e.g. `pino-roll`, which
  does support size-based rotation) or an explicit size-check-and-rotate
  implemented in main (stat the file on an interval / before each write batch,
  rename-and-reopen past the threshold). This is a real new dependency (or a
  real chunk of hand-rolled rotation logic) — not the "no new dependency"
  claim in the earlier draft.
- All processes land there: renderers/hidden hosts already forward via
  `logging:ingest-buffered-record`; the ingest handler now also feeds the error
  file sink (today it only feeds the in-memory buffer).
- Line shape = the `diagnostic_events` row shape (same serializer), so a grep
  hit in the file and a SQL row are the same object — one mental model, and
  external agents get `jq`-able structure for free.
- `brainstrike.log` (full INFO) keeps existing behavior but gains the same
  rotation so it stops growing unboundedly. Settings' existing
  `logging:open-destination` button surfaces the folder.

Web variant: no file. The equivalent affordance is **Export errors (NDJSON)**
in the Log Viewer, generated from the table — honest capability difference,
same output format.

---

## 8. Agent self-service (G5)

New read-risk native tool `brainstrike.queryDiagnostics` (full multi-registry
checklist: contract id/description, Zod schema in `NATIVE_TOOL_INPUT_SCHEMAS`,
desktop registry, risk map):

```ts
{ severity?: 'warn'|'error'|'fatal', sinceMinutes?: number,
  threadId?: string, code?: string, fingerprint?: string, limit?: number }
```

Returns bounded rows (self-fitting projection within the domain-projector
budget; overflow pages via the standard artifact/continuation path). This lets
the in-app assistant answer "why did my last run fail?" or "what's been failing
in the background today?" from durable data — no reproduction needed. Desktop
first; web can follow via the same repository (no server dependency — it's a DB
read).

Follow-up (out of scope): exposing the same query through the Agent Hub MCP
server (#1187) for external agents; the NDJSON file covers them meanwhile.

---

## 9. UI surfaces

- **Log Viewer**: add a second `LogSourceAdapter` — "Persistent errors" — backed
  by a PGlite live query over `diagnostic_events` (the adapter contract already
  abstracts source). Filters: severity, source, code, time range; row → detail
  with cause chain; per-row "Copy as JSON".
- **Background-error visibility**: a status-bar chip showing count of new warn+
  events since last viewed (session-scoped "seen" watermark); click opens the
  viewer. This is the "even in the background invisibly" ask made visible.
- **Settings**: retention controls (days/rows), "Purge now", file-log rotation
  info + open-folder (existing button), and the sink-health banner (§4.3).

---

## 10. Phasing

| Phase | Scope | Key risk retired |
| --- | --- | --- |
| **P1 — Durable log** | Migration + writer + capture wiring (logger listener, boundaries, main-process, queue adapter) + retention + factory reset | The store exists; background errors survive close |
| **P2 — Surfaces** | Log Viewer persistent source, status-bar chip, settings, web NDJSON export, **desktop warn+ NDJSON file backstop + rotation (moved from P5 — see below)** | Errors are *seen*, not just stored; the DB-sink failure path has a durable destination before broad reliance |
| **P3 — Run-error enrichment** | `run_errors` table, header-capturing fetch wrapper, retry-attempt recording, error-block code/request-id display | Multi-provider forensics |
| **P4 — Debug bundle** | Builder + Copy/Save UI + bounds/redaction + tests with golden bundles | The headline feature; depends on P1+P3 for full value but ships useful after P1 |
| **P5 — Agent access** | `brainstrike.queryDiagnostics` tool | Agents diagnose without re-running |

**Move (review follow-up):** the desktop warn+ NDJSON backstop (file sink +
rotation, §7) moved from P5 into **P2**. Rationale: the file mirror is the
DB-sink's failure backstop (§4.3 "Loop guard" / "Corruption interplay") — it
needs to exist before the app leans on the DB sink broadly, not after. P5 now
scopes down to just the `queryDiagnostics` tool, which has no dependency on
the file sink.

Each phase is independently shippable and testable; P1 is the only hard
prerequisite for the others. Suggested order P1→P4a (bundle over existing data
only)→P3→P4b→P2 (now includes the NDJSON backstop)→P5 if the bundle is the
most urgent pain.

## 11. Testing

- **P1**: migration tests in both runners (+ lane-manifest regex); writer unit
  tests (batching, overflow-loud, loop guard, corruption-generation buffering,
  **eager flush on `error`/`fatal` severity, no eager flush on `warn`**);
  integration: real PGlite, error hook → row round-trip; factory-reset test
  extension.
- **P2**: NDJSON rotation integration test (desktop lane) — **moved here from
  P5** alongside the backstop's move (§10).
- **P3**: fetch-wrapper header whitelist tests (never a non-whitelisted key);
  integration spec extension in `mastra-error-processors.spec.ts` (attempts
  recorded); golden `run_errors` row from a scripted provider failure;
  **required conflict test (§6): two terminal choke points racing on the same
  `run_id` leave the first writer's classification fields unchanged and merge
  both writers' `attempts` entries.**
- **P4**: golden-bundle snapshot tests (fixed fake data → byte-stable Markdown);
  bound/elision tests (oversized transcript → visible markers, ≤ budget);
  redaction test (seeded secrets never appear in output, including the
  value-shape secret scrub over the final rendered string).
- **P5**: tool registered across the multi-registry checklist tests.

## 12. Invariants honored (checklist)

- No silent fallbacks: sink failure → visible banner + file record; elision →
  visible markers; dropped events → counted loudly.
- Dual migration runners + lane manifest (database contract).
- Factory reset covers the new table, the seen-watermark store, and settings.
- Capability gating by composition, never `isElectron()`.
- Latency-critical paths untouched: capture is listener-side, writes batched,
  never awaited by the stream.
- Redaction at capture AND at bundle assembly (logger key set).
- Command-session privacy contract untouched: command text/cwd/env/output are
  never logged today and this design does not add them to any sink.

## 13. Open decisions (for Sean)

1. **Retention defaults** — proposed 30 days / 20k rows. OK?
2. **Severity floor** — proposed `warn+` durable. Include `info` for specific
   scopes (e.g. provider requests) or keep it lean?
3. **Bundle transcript privacy** — default includes message text + tool args
   (redacted). Want a "metadata-only" bundle variant toggle for sharing outside
   your machine?
4. **Naming** — `brainstrike_diagnostic_events` vs `brainstrike_error_log`.
   Doc uses the former (it stores warnings too).
5. **Phase order** — P1→P4a fastest path to the copy button; confirm priority.
