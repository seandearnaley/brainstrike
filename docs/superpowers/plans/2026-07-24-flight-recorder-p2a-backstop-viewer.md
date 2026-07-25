# Flight Recorder P2a — NDJSON Backstop + Persistent Log Viewer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the durable diagnostic store a file backstop on desktop (`brainstrike-errors.ndjson`, warn+, rotated) and make its rows visible in the settings Log Viewer on both platforms, with NDJSON export.

**Architecture:** One in-process sink in the Electron main process hangs off the two points `logging-ipc.ts` already taps (`addLogListener` for main-process records; the `ingestBufferedRecord` handler for renderer/hidden-host records), converts each warn+ `LogRecord` with P1's `logRecordToDiagnosticEvent`, and appends one NDJSON line whose shape is byte-identical to a `brainstrike_diagnostic_events` row. In the renderer, a polling `LogSourceAdapter` reads the same rows out of PGlite and maps them to `LogRecord`s so the **existing** Log Viewer renders them unchanged.

**Tech Stack:** TypeScript strict, Electron main (node:fs), PGlite, React 19, Vitest.

**Spec:** `docs/error-observability-design-2026-07-23.md` §7 (desktop text log / web variant) and §9 (UI surfaces, first two bullets). P1 (merged, #1948) supplies: `DiagnosticEvent`, `logRecordToDiagnosticEvent`, `DiagnosticEventsRepository`, migration 073, `DIAGNOSTIC_SINK_SCOPE`.

**Explicitly OUT of scope (P2b):** status-bar unseen-error chip, retention settings UI + "Purge now", sink-health banner.

## Global Constraints

- **NO new dependency.** Rotation is hand-rolled. Rationale (do not relitigate): pino transports run in a worker thread and only observe main-process pino output — they never see IPC-forwarded renderer/hidden-host records, which is exactly what this backstop must capture. Owning the fd also permits a synchronous flush inside the 5s `SIGNAL_SHUTDOWN_TIMEOUT_MS` shutdown budget.
- **NO SILENT FALLBACKS**: a sink write/rotate failure disables the sink and reports once through `console.error` ONLY (never `logger.*` — that would re-enter the tap and recurse). Truncation/elision keeps visible markers.
- `BRAINSTRIKE_DISABLE_FILE_LOGS=1` must disable the NDJSON sink exactly as it disables `brainstrike.log` (every desktop `test:e2e*` script sets it).
- Line shape MUST equal the DB row shape (same serializer) — a grep hit and a SQL row are the same object.
- Capability gating by composition; the renderer durable source gates on the **db handle** (`useOptionalPGliteDatabase()`), never `hasDurableAssistantUsageCapability()` (desktop-only) and never `isElectron()`.
- TypeScript strict, never `any`; kebab-case files; hooks `use-*.ts`.
- Run `pnpm dlx ultracite fix <files>` before committing; the bar is build + lint + type-check + tests green in one run.

## File Structure

```
packages/utils/src/diagnostics/diagnostic-event-ndjson.ts   # shared line serializer (+ parse)
apps/desktop/src/diagnostics/rotating-ndjson-sink.ts        # fd-owning rotating writer (node fs)
apps/desktop/src/diagnostics/error-log-sink.ts              # LogRecord -> event -> line wiring + lifecycle
apps/desktop/src/logging-ipc.ts                             # (modify) call the new durable-record handler
apps/desktop/src/main.ts                                    # (modify) construct/dispose sink, shutdown step
packages/app-shell/src/diagnostics/durable-log-source.ts    # DiagnosticEvent->LogRecord + polling adapter
packages/app-shell/src/diagnostics/use-durable-log-source.ts# hook returning LogSourceAdapter | undefined
packages/preferences/.../logging-settings-section.tsx       # (modify) Session/Persistent switch + empty state
apps/web/src/app/settings/page-content.tsx                  # (modify) pass durable source
apps/desktop/src/renderer/components/settings/logging-settings.tsx # (modify) pass durable source
```

---

### Task 1: NDJSON line serializer (shared)

**Files:** Create `packages/utils/src/diagnostics/diagnostic-event-ndjson.ts`; export from `packages/utils/src/diagnostics/index.ts`. Test: `packages/utils/src/__tests__/diagnostic-event-ndjson.test.ts`.

**Interfaces (later tasks depend on these exact names):**
- `serializeDiagnosticEventLine(event: DiagnosticEvent): string` — one line, NO trailing newline, no raw newlines inside (JSON.stringify escapes them). Keys emitted in a FIXED order (declare a `const NDJSON_KEY_ORDER` and build the object from it) so file diffs and DB exports are stable.
- `parseDiagnosticEventLine(line: string): DiagnosticEvent | null` — returns null for blank/malformed lines (a truncated tail line after a crash must not throw); callers decide what to do.
- `serializeDiagnosticEventsNdjson(events: readonly DiagnosticEvent[]): string` — lines joined by `\n` with a trailing `\n` (used by the web export in Task 6).

**Steps:**
- [ ] Write failing tests: round-trip (serialize→parse deep-equals the event, including `causeChain`/`context` nulls); output contains no `\n` for an event whose `message` and `stack` contain newlines; key order is stable across two differently-ordered input objects; `parseDiagnosticEventLine('')` and `('{bad json')` and `('{"id":"x"}')` (missing required fields) all return `null`; `serializeDiagnosticEventsNdjson` ends with exactly one trailing newline.
- [ ] Run: `pnpm --filter @brainstrike/utils exec vitest run src/__tests__/diagnostic-event-ndjson.test.ts` → FAIL (module missing).
- [ ] Implement. Validation in `parse` must check the required fields (`id`, `occurredAt`, `severity`, `source`, `message`, `fingerprint`, `sessionId`, `appVersion`, `platform`) and the severity enum; anything else → `null`.
- [ ] Run tests → PASS. Then `pnpm --filter @brainstrike/utils exec vitest run` (whole package) green.
- [ ] `pnpm dlx ultracite fix` the two files; commit `feat(diagnostics): stable NDJSON line serializer for diagnostic events`.

---

### Task 2: Rotating NDJSON sink (desktop, fd-owning)

**Files:** Create `apps/desktop/src/diagnostics/rotating-ndjson-sink.ts`. Test: `apps/desktop/src/__tests__/diagnostics/rotating-ndjson-sink.integration.test.ts` (real fs → `.integration.` suffix, per the repo's integration-lane convention; mirror the `mkdtemp` + `afterEach` rm pattern in `apps/desktop/src/__tests__/git-ipc-handlers.integration.test.ts`).

**Interfaces:**
```ts
export interface RotatingNdjsonSinkOptions {
  readonly filePath: string;
  readonly maxBytes?: number;     // default 10 * 1024 * 1024
  readonly maxFiles?: number;     // default 5 (the live file + 4 rotated siblings)
  readonly onFailure?: (error: unknown) => void;  // called ONCE when the sink disables itself
}
export class RotatingNdjsonSink {
  constructor(options: RotatingNdjsonSinkOptions);
  get disabled(): boolean;
  writeLine(line: string): void;  // sync append; never throws
  close(): void;                  // idempotent; closes the fd
}
```

Semantics (test-pinned):
- Lazily opens the fd with `fs.openSync(filePath, 'a')` on first write; `mkdirSync(dirname, {recursive:true})` first. Tracks byte length in memory, seeded from `fs.fstatSync(fd).size` at open (so an existing file's size counts).
- Before appending, if `currentSize + Buffer.byteLength(line) + 1 > maxBytes` **and** `currentSize > 0`, rotate first. A single line larger than `maxBytes` is still written (never dropped) to its own freshly-rotated file.
- Rotation: close fd → for `i = maxFiles - 1` down to `1`: rename `file.i` → `file.(i+1)` when it exists (the highest is overwritten, i.e. oldest is dropped) → rename live file → `file.1` → reopen. Rotated names are `<filePath>.1` … `<filePath>.<maxFiles-1>`.
- Writes append `line + '\n'` via `fs.writeSync`.
- **Failure handling:** any throw from open/write/rotate sets `disabled = true`, calls `onFailure(error)` exactly once, and every later `writeLine` is a silent no-op. `writeLine` NEVER throws (the caller is a log listener). Do NOT log through `@brainstrike/utils/logger` anywhere in this file — that re-enters the tap and recurses.

**Steps:**
- [ ] Write failing integration tests: writes newline-delimited lines readable back with `parseDiagnosticEventLine`; rotates when the byte budget is exceeded and the live file restarts small; after `maxFiles` rotations only `maxFiles` files exist (oldest dropped); an oversized single line is still written; sizes carry over across a reopen (construct a second sink over the same path and confirm it rotates without re-writing history); failure path — point the sink at a path whose parent is a FILE (forcing an open error), assert `disabled === true`, `onFailure` called once, later `writeLine` calls do not throw and do not call `onFailure` again.
- [ ] Run: `pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts src/__tests__/diagnostics/rotating-ndjson-sink.integration.test.ts` (confirm the real integration config/script name in `apps/desktop/package.json` first — use whatever `test:integration` runs) → FAIL.
- [ ] Implement, then re-run → PASS.
- [ ] `ultracite fix`; commit `feat(desktop): rotating NDJSON sink for the diagnostic error log`.

---

### Task 3: Wire the sink into main (both record sources) + shutdown

**Files:** Create `apps/desktop/src/diagnostics/error-log-sink.ts`; modify `apps/desktop/src/logging-ipc.ts` and `apps/desktop/src/main.ts`. Test: `apps/desktop/src/__tests__/diagnostics/error-log-sink.test.ts` + extend `apps/desktop/src/__tests__/logging-durable-record.test.ts`.

**`error-log-sink.ts` interface:**
```ts
export interface ErrorLogSinkHandle {
  readonly filePath: string;
  recordLogRecord(record: LogRecord): void;   // warn+ filtering is the CALLER's job (already done upstream)
  close(): void;
}
export function createErrorLogSink(options: {
  filePath: string;
  appVersion: string;
  platform: string;
  sessionId: string;
  maxBytes?: number;
  maxFiles?: number;
}): ErrorLogSinkHandle;
```
`recordLogRecord` converts via `logRecordToDiagnosticEvent(record, env)` (P1, from `@brainstrike/utils/diagnostics`) — `makeId: () => randomUUID()`, `source` derived from the record's bindings exactly as the renderer bridge does: `bindings['runtime'] === 'electron-main' ? 'electron-main' : String(bindings['sourceWindowRole'] ?? 'hidden-host')`. A `null` conversion result (below the severity floor) is skipped. Then `serializeDiagnosticEventLine` → `sink.writeLine`. `onFailure` for the underlying sink writes ONE `console.error` (never the logger).

**`logging-ipc.ts` modification:** add an optional handler `recordDurableLog?: (record: LogRecord) => void` to the handlers object `registerLoggingIpcHandlers` accepts, and call it at BOTH existing warn+ choke points — beside the `pushDurableRecordToVisibleWindow(record)` call in the `addLogListener` tap, and beside the one in the `ingestBufferedRecord` handler (pass the SAME record object that gets the `sourceWindowRole` binding merged in). Do not add a second level filter — `DURABLE_PUSH_LEVELS` already gates both sites.

**`main.ts` modification:** at app-ready (beside the existing file-logging re-enable / `verifyActiveLogFile('app-ready')` call), when `!disableFileLogs`, construct the sink at `path.join(app.getPath('logs'), 'brainstrike-errors.ndjson')` with `appVersion: app.getVersion()`, `platform: `${process.platform}-${process.arch}``, and a per-launch `sessionId` (`randomUUID()`), store it in a module-level `let errorLogSink: ErrorLogSinkHandle | null`, and pass `recordDurableLog: (record) => errorLogSink?.recordLogRecord(record)` into `registerLoggingIpcHandlers`. Add a final `runShutdownStep('error-log-sink', () => { errorLogSink?.close(); errorLogSink = null; })` in `runGracefulShutdown` **after** the `'database'` step (the file is the last writer standing, so it captures failures from every earlier step).

**Steps:**
- [ ] Write failing tests: (a) `error-log-sink.test.ts` — a fabricated main-process ERROR `LogRecord` produces one parseable line whose `source === 'electron-main'`, `severity === 'error'`, and whose `sessionId`/`appVersion`/`platform` match construction; a record with `bindings.sourceWindowRole = 'hidden-host'` yields `source === 'hidden-host'`; an INFO record writes nothing. Use a tmpdir file and read it back with `parseDiagnosticEventLine`. (b) extend `logging-durable-record.test.ts` — assert `recordDurableLog` is invoked for a warn+ main record AND for an ingested renderer record, and NOT for an INFO record (mirror the existing harness in that file exactly).
- [ ] Run both → FAIL.
- [ ] Implement the module + the two wiring edits. Verify by reading `main.ts` that `BRAINSTRIKE_DISABLE_FILE_LOGS` short-circuits construction.
- [ ] Run: the two test files, then `pnpm --filter @brainstrike/desktop test` (full desktop unit lane) → PASS.
- [ ] `ultracite fix`; commit `feat(desktop): write warn+ records to the rotating NDJSON backstop`.

---

### Task 4: DiagnosticEvent → LogRecord mapper + durable log source

**Files:** Create `packages/app-shell/src/diagnostics/durable-log-source.ts`. Test: `packages/app-shell/src/__tests__/durable-log-source.test.ts`.

**Interfaces:**
```ts
export const DURABLE_LOG_SOURCE_POLL_MS = 5000;
export const DURABLE_LOG_SOURCE_MAX_ROWS = 2000;
export function diagnosticEventToLogRecord(event: DiagnosticEvent): LogRecord;
export function createDurableLogSource(options: {
  db: DiagnosticEventsDatabase;
  limit?: number;
  pollMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}): LogSourceAdapter;   // structural: { getInitialRecords, subscribe }
```

Mapping rules (test-pinned) — the existing viewer must render these honestly:
- `timestamp: event.occurredAt`; `scope: event.scope ?? undefined`; `message: event.message`.
- `level`: `warn → LogLevel.WARN`, `error → LogLevel.ERROR`, `fatal → LogLevel.FATAL`.
- `bindings`: `{ runtime: event.source, code, fingerprint, sessionId, appVersion, platform, ...(runId/threadId/resourceId/rootId when non-null) }` — `runtime` carries the source so the viewer's existing `getRuntimeSource` attribution reads honestly. Omit null-valued keys rather than emitting nulls.
- `args`: a single trailing object `{ logSource: event.source, ...(stack ? {stack} : {}), ...(causeChain ? {causeChain} : {}), ...(context ?? {}) }` — the viewer serializes args into the row detail, so stack + cause chain become visible there.

Adapter behavior:
- **Do NOT use `DiagnosticEventsRepository.queryEvents`**: it hard-caps `limit` at 200 and its `severity` filter is equality, not a minimum. Issue the query directly: `SELECT * FROM brainstrike_diagnostic_events WHERE severity IN ('warn','error','fatal') ORDER BY occurred_at DESC, id DESC LIMIT $1` with `limit` bound once, mapping rows with the same row→event mapping the repository uses (import/reuse it if exported; otherwise map inline and note the duplication).
- `getInitialRecords()` runs one query and returns records **ascending by timestamp** (the viewer re-sorts anyway, but be consistent).
- `subscribe(handler)` fires an immediate load, then re-queries every `pollMs`, invoking `handler` with the full snapshot each time (the adapter contract is snapshot-based, and the viewer debounces at 100ms). Returns an unsubscribe that clears the interval and prevents late in-flight results from calling the handler. Polling is a deliberate v1 choice over a live query: the adapter contract is imperative while `usePGliteLiveQuery` is a React hook; the Refresh button remains wired via `getInitialRecords`. Note it in a comment.
- A query rejection must not throw into the timer: catch, and surface it by invoking `handler` with a single synthetic WARN `LogRecord` (`scope: 'DurableLogSource'`, message naming the failure) — the same honest-degradation precedent as `loadDesktopLogRecords` appending a synthetic record when main-process logs can't be read. Never silently show an empty list.

**Steps:**
- [ ] Write failing tests over a stub `{ query }` db: mapping (each severity → level; bindings carry `runtime`/`code`/`fingerprint`; null correlation ids omitted; args carry stack + causeChain); `getInitialRecords` returns ascending records; `subscribe` emits immediately, again after an injected interval tick, and stops after unsubscribe; a rejecting query yields the synthetic WARN record rather than throwing; the SQL binds the limit exactly once and filters `severity IN`.
- [ ] Run → FAIL. Implement. Run → PASS.
- [ ] `ultracite fix`; commit `feat(diagnostics): durable log source adapter over diagnostic events`.

---

### Task 5: Wire the persistent source into both apps' settings

**Files:** Create `packages/app-shell/src/diagnostics/use-durable-log-source.ts`; modify `packages/preferences/src/settings/system/logging-settings-section.tsx`, `apps/web/src/app/settings/page-content.tsx`, `apps/desktop/src/renderer/components/settings/logging-settings.tsx`. Test: `packages/app-shell/src/__tests__/use-durable-log-source.test.tsx` + extend the existing logging-settings-section test if one exists (`grep -rn "LoggingSettingsSection" packages/preferences/src/__tests__ -l`).

**Interfaces:**
- `useDurableLogSource(): LogSourceAdapter | undefined` — `useOptionalPGliteDatabase()`; returns `undefined` without a db handle (capability by composition); otherwise a `useMemo`'d `createDurableLogSource({ db })` keyed on the db identity. **Identity must be stable** — the viewer's effect deps include `logSource`, so an unstable object tears down and re-subscribes every render (the same hazard the desktop `forwardedRecords` prop hit in P1).
- `LoggingSettingsSectionProps` gains `durableLogSource?: LogSourceAdapter`.

**Section UI:** when `durableLogSource` is present, render a small two-option control immediately above `<LogViewer>` (reuse the section's existing control primitives — do not invent new visual language): **Session** (default, the existing `logSource`) and **Persistent errors**. Selecting swaps which adapter is passed to `<LogViewer logSource={...}>`; the viewer already re-subscribes on identity change. When `durableLogSource` is absent, render exactly what ships today (no control, no layout shift). Add an `emptyStateText` prop to `LogViewer`/`log-list.tsx` defaulting to today's "No logs recorded for the current session." and pass "No durable warn+ events recorded." for the persistent source — the current copy is a lie for the durable source.

**Both apps:** call `useDurableLogSource()` and pass it as `durableLogSource`. Web: alongside the existing `logSource` memo in `page-content.tsx`. Desktop: alongside the existing memo in `logging-settings.tsx`.

**Steps:**
- [ ] Write failing tests: `use-durable-log-source` returns `undefined` with no db and a STABLE adapter across re-renders with a db (assert `Object.is` across two renders); section renders no source control without `durableLogSource` and both options with it; selecting "Persistent errors" passes the durable adapter to the viewer (assert via a stubbed `LogViewer` or by observing which adapter's `subscribe` is called).
- [ ] Run → FAIL. Implement. Run → PASS.
- [ ] Run `pnpm turbo run type-check test --filter=@brainstrike/app-shell --filter=@brainstrike/preferences --filter=@brainstrike/web --filter=@brainstrike/desktop` (use the real package names). Extend any settings-page snapshot/architecture guard that fails — that failure is the guard working.
- [ ] `ultracite fix`; commit `feat(settings): Session/Persistent switch in the Log Viewer`.

---

### Task 6: Export errors (NDJSON)

**Files:** modify `packages/preferences/src/settings/system/logging-settings-section.tsx` (button), `packages/app-shell/src/diagnostics/durable-log-source.ts` (export query). Test: extend `packages/app-shell/src/__tests__/durable-log-source.test.ts`.

- Add `exportNdjson(): Promise<string>` to the object `createDurableLogSource` returns (widen its return type to `LogSourceAdapter & { exportNdjson(): Promise<string> }` — declare that as `DurableLogSource`), producing `serializeDiagnosticEventsNdjson(events)` over the same bounded query.
- In the section, when the Persistent source is selected, render an "Export NDJSON" button beside the source control that downloads `brainstrike-errors-<iso>.ndjson` via the same Blob-anchor approach `handleExportLogs` uses in `log-viewer.tsx` (`type: 'application/x-ndjson'`). This is the honest web equivalent of the desktop file (§7).

**Steps:**
- [ ] Write failing test: `exportNdjson()` returns newline-delimited lines each parseable by `parseDiagnosticEventLine`, ending with one trailing newline.
- [ ] Run → FAIL. Implement (adapter + button). Run → PASS. Add a section test asserting the button appears only for the persistent source.
- [ ] `ultracite fix`; commit `feat(settings): export durable diagnostics as NDJSON`.

---

### Task 7: Docs + full verification

**Files:** modify `docs/agents/platform-contracts.md` (the DIAGNOSTIC EVENTS section) and `docs/error-observability-design-2026-07-23.md` (status line).

- [ ] Contract doc: add a paragraph documenting (a) the desktop NDJSON backstop — path, warn+ only, 10 MB × 5 rotation, fed from the two `logging-ipc` choke points (NOT a pino transport, with the one-line reason), `BRAINSTRIKE_DISABLE_FILE_LOGS` gate, sync-flush-on-shutdown step ordering after `'database'`, and the no-logger-inside-the-sink recursion rule; (b) the persistent Log Viewer source — polling interval, the db-handle capability gate, and that the viewer's `queryEvents` cap is deliberately bypassed with direct SQL.
- [ ] Design doc: change the status line to `Status: P1 + debug bundle + P2a (NDJSON backstop, persistent Log Viewer) IMPLEMENTED; P2b (status chip, retention settings) / P3 / P5 pending.`
- [ ] Full verification from the worktree root, all green in one run: `pnpm build && pnpm lint && pnpm type-check && pnpm test`. Investigate any failure; do not paper over it. Report pre-existing failures separately rather than fixing in-band.
- [ ] Commit `docs: platform contract for the NDJSON backstop + persistent log source`. Do NOT push (the controller pushes and opens the PR).

## Self-Review (performed at plan-writing time)

- **Spec coverage:** §7 desktop file + rotation (T2/T3), §7 line-shape-equals-row-shape (T1), §7 web NDJSON export equivalent (T6), §9 persistent Log Viewer source (T4/T5). Deferred by explicit scope decision: §9 status chip + settings retention/purge/banner (P2b). **Also NOT delivered, recorded honestly during post-implementation review**: §7's "`brainstrike.log` (full INFO) gains the same rotation" — this branch rotates only the new `brainstrike-errors.ndjson` file; the unbounded INFO log is untouched. §9's Log Viewer bullet 1 richer affordances — delivered: the second `LogSourceAdapter` ("Persistent errors") + severity filtering (via the viewer's existing level filter); NOT delivered: dedicated source/code filters, a time-range filter, a row-detail view with cause chain, or per-row "Copy as JSON" (the cause chain is currently visible only as serialized text in the args column).
- **Verify-first points flagged inline:** the desktop integration test script name, whether the repository's row→event mapper is exported for reuse, whether a `LoggingSettingsSection` test file exists, real package names for turbo filters.
- **Type consistency:** `LogSourceAdapter` is structural `{ getInitialRecords?, subscribe? }` (re-exported from `logging-settings-section.tsx`); `DurableLogSource` extends it with `exportNdjson`; `DiagnosticEventsDatabase` is `{ query<T>(sql, params?) }`.
