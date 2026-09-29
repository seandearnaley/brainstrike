# Log Viewer controls and the persistent source — evidence

Supports `docs/agents/platform-contracts.md` § "P2a: NDJSON backstop + persistent Log Viewer source".
Read before changing the Log Viewer filters or the durable log source and its polling. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**Log Viewer diagnostic controls**: the viewer exposes dedicated source and
code selectors populated from the active adapter's records, plus inclusive
local From/To timestamp inputs. Source prefers explicit `logSource` context
and then the runtime binding; missing codes remain a selectable "No code"
case rather than being coerced into an invented value. An invalid time range
is visibly marked and yields no matching rows. Each row has a structured
detail dialog for source, code, fingerprint, message, cause chain, stack, and
context, plus "Copy JSON" routed through the shared clipboard service. Copy
serialization is lazy (on click), cycle-safe, and explicit about values JSON
cannot represent directly, so malformed diagnostic context cannot crash the
table render or silently produce an empty clipboard payload.

**Persistent Log Viewer source** (`createDurableLogSource` +
`useDurableLogSource`,
`packages/app-shell/src/diagnostics/durable-log-source.ts` and
`use-durable-log-source.ts`, wired into the Session/Persistent switch in
`packages/settings-ui/src/settings/system/logging-settings-section.tsx`):
gated on `useOptionalPGliteDatabase()` returning a live db handle — NOT
`hasDurableAssistantUsageCapability()` (that gate is desktop-only OM
persistence; diagnostics are written on both web and desktop, so the correct
gate is capability-by-composition, "is there a db handle," never a platform
check). Polls every `DURABLE_LOG_SOURCE_POLL_MS` (5000ms; the viewer's
existing Refresh button already covers on-demand re-fetch, so polling only
needs to cover the gap between refreshes) for up to
`DURABLE_LOG_SOURCE_MAX_ROWS` (2000) warn+ rows. Deliberately bypasses
`DiagnosticEventsRepository.queryEvents` with direct SQL: that repository
method hard-caps `limit` at 200 and its `severity` filter is equality (not a
minimum), so it cannot serve a 2000-row warn-and-above view — the row
mapping (`mapDiagnosticEventRow`) is still reused to avoid duplicating it.
`subscribe()` guards against overlapping polls with a monotonic
`latestRequestId` counter: only the result whose request id still matches
the latest-issued poll is delivered, so a slow tick can never clobber a
newer one that resolved first. The adapter returned by `createDurableLogSource`
is a fresh object on every call by contract; `useDurableLogSource` memoizes
it keyed on the db handle's identity so it stays referentially STABLE across
re-renders — the Log Viewer's effect keys its subscribe/teardown on adapter
identity, so an unstable adapter would restart polling on every render (the
same hazard the desktop `forwardedRecords` prop hit in P1). The NDJSON
export button (`onExportDurableNdjson` in `logging-settings-section.tsx`)
and the viewer share the same bounded `loadEventsAscending` query as their
single source of truth, and `exportNdjson()` deliberately has no try/catch —
a rejected export must propagate so the caller can surface it visibly,
rather than a swallowed failure rendering as a successful-but-empty file.

**Paired tests**: `packages/utils/src/__tests__/diagnostic-event-ndjson.test.ts`,
`apps/desktop/src/__tests__/diagnostics/rotating-file-sink.integration.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-log-transport.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-log-transport-path.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-log-transport-worker.integration.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-core.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-path.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-runtime.test.ts`,
`apps/desktop/src/__tests__/diagnostics/main-watchdog-worker.integration.test.ts`,
`apps/desktop/src/__tests__/build-main-config.test.ts`,
`apps/desktop/src/__tests__/diagnostics/error-log-sink.test.ts`,
`apps/desktop/src/__tests__/logging-durable-record.test.ts` (the
`recordDurableLog handler` describe block covers the two `logging-ipc.ts`
choke points feeding the sink),
`packages/app-shell/src/__tests__/durable-log-source.test.ts`,
`packages/app-shell/src/__tests__/use-durable-log-source.test.tsx`,
`packages/settings-ui/src/settings/system/logging-settings-section.test.tsx`,
`packages/settings-ui/src/settings/system/log-viewer-components/__tests__/log-viewer.test.tsx`,
`packages/ui/src/__tests__/copy-text-button.test.tsx`.
