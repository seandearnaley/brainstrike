# Status chip, retention preferences, sink health — evidence

Supports `docs/agents/platform-contracts.md` § "P2b: status chip, retention preferences, sink health".
Read before changing the unseen-diagnostics chip, the retention store, the shared sanitized `merge`, the purge row, or the sink-health banner. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**Unseen-diagnostics status chip** (`DiagnosticsStatusItem`,
`packages/app-shell/src/status-items/diagnostics-status-item.tsx`, mounted in
`app-layout.tsx`'s `rightContent` before `IndexingStatusItem`) backed by
`useUnseenDiagnosticsCount` (`.../diagnostics/use-unseen-diagnostics-count.ts`):
a single `usePGliteLiveQuery` aggregate over rows newer than the watermark. The
table's CHECK constraint defines the complete warn+ set; two `FILTER` clauses
partition that set for honest labels rather than deciding eligibility: `warn`
stays in the warning bucket, while `error` and `fatal` share the error bucket.
Warning-only rows render `N warnings`; mixed rows render `N errors, M warnings`
visibly and `N errors and M warnings` to assistive technology. The chip renders
`null` when both counts are 0 (no chrome when nothing is wrong), but ALL
not-knowing classes outrank the counts, because
this is the only always-visible diagnostics surface: a live-query error
renders "Diagnostics unavailable" rather than the honest-looking `0`.
Present aggregate values are validated strictly: only a non-negative safe-integer
number or decimal-digit string with no surrounding whitespace is accepted. Null,
blank, non-integer, negative,
boolean, array, object, non-decimal, or otherwise unsafe values render
"Diagnostics unavailable" rather than being coerced via `Number()`. A non-null
`disabledReason` renders
"Diagnostics not recording" — outranking
even non-zero counts, since those counts are frozen and stale once the sink is
dead. Without the latter, a disabled sink writes no rows, both counts sit at 0
forever, and the status bar silently claims "no diagnostics" precisely when
diagnostics have stopped being recorded; the settings banner alone cannot cover that,
because a user has no reason to open settings while the status bar looks
clean. Clicking marks all seen, opens settings, and routes to
`#settings/logging`.

The watermark (`diagnostics-seen-store.ts`) is **session-scoped, seeded to
`Date.now()` at module load, and deliberately NOT persisted**: a persisted
watermark would replay up to 20,000 retained rows as unread on every launch,
so the chip means "warn+ events since this launch," not "since you last
looked." Do not "fix" this by adding `persist`.

**Retention preferences** (`packages/app-state/src/stores/diagnostics-retention-store.ts`,
persisted): `maxAgeDays` / `maxRows`, chosen from
`DIAGNOSTICS_RETENTION_DAY_OPTIONS` / `DIAGNOSTICS_RETENTION_ROW_OPTIONS`.
Defaults MUST equal `DIAGNOSTIC_RETENTION_MAX_AGE_MS` / `_MAX_ROWS` so
behavior is unchanged until a user edits them (a test asserts the equality by
importing both, rather than hardcoding the numbers twice). Setters **throw**
on a value outside the option list — malformed config is loud, never coerced.
Both `migrate` and the store's sanitized `merge` validate an unknown persisted
payload back to defaults. The merge is required because Zustand skips
`migrate` when the stored version already matches; it preserves live actions
and applies only the sanitizer's complete persisted-data shape. When storage
has no snapshot (`persistedState === undefined`), the shared merge returns the
current store unchanged so defaults or a late hydration cannot overwrite live
state. Hydration sanitizes in memory but deliberately does not rewrite storage.
The shared merge is also installed on the notification, assistant-budget,
permission-policy, skills, background-indexing, hook-trust, subagent-personas,
token, vector, and workspace-instructions preference stores. Stores with custom
storage parsers (panel layouts) and the assistant-memory store's explicit
rehydration sanitizer already enforce the same current-version boundary through
their own specialized paths.

**Purge path**: the settings card always renders its persisted retention
selectors, including while no database handle is available. Only its "Purge
now" row is capability-gated by the optional
`onPurgeNow?: () => Promise<number>` **callback prop**. That callback reaches
the repository without a repository import — `app-shell` already depends on
`preferences`, so that direction is circular (same precedent as
`onExportDurableNdjson`). Both apps build it from `useDiagnosticsPurge()`
(`packages/app-shell/src/diagnostics/use-diagnostics-purge.ts`), gated on a db
handle. Without that capability the card explicitly says the configured limits
apply once the local database is available; the missing action row is never the
only signal that enforcement is deferred. Because a single `purge()` is
per-call bounded, a returned count at or
above the per-call limit toasts "more may remain" instead of implying a full
drain; `logging-settings-section.tsx` mirrors that limit as
`DIAGNOSTIC_PURGE_MAY_REMAIN_THRESHOLD` (it must not import `@brainstrike/db`
at runtime) and the section test imports the REAL exported
`DIAGNOSTIC_EVENTS_PURGE_LIMIT`, so drift fails RED rather than silently
under-warning.

**Sink health** (`diagnostic-sink-health-store.ts` → `sinkHealthReason` prop →
amber banner at the top of the logging settings section): the writer's
`onDisabled` callback is the **ONLY** signal a broken sink can ever emit,
because the `DIAGNOSTIC_SINK_SCOPE` loop guard keeps the sink's own failures
out of the table — a disabled sink otherwise renders as an empty Persistent
view, which reads as "no errors happened" rather than "errors are no longer
being recorded". It travels through a module-level store rather than React
context because `DiagnosticSinkBridge` mounts inside `<DbProvider>` but
OUTSIDE `RootLayoutContent`, so no shared provider spans both. `markDisabled`
is idempotent — first reason wins, so a later failure racing the disable
cannot overwrite the root cause shown to the user. A new database identity
constructs a replacement writer and clears the prior writer's reason; changing
other bridge props for the same database MUST NOT clear it. Each writer's
`onDisabled` callback is generation-scoped, so a retired writer's asynchronous
dispose/flush cannot re-arm stale health after replacement. The replacement
starts clean and re-arms the warning only after its own bounded
`maxConsecutiveFailures` window, so the banner can be briefly clear while that
failure threshold accumulates.

**Factory reset (all three P2b stores)**: the two session stores
(`resetDiagnosticsSeenStore`, `resetDiagnosticSinkHealthStore`) are reset by
`resetAppShellSessionStores`, which is registered in
`packages/app-shell/src/register-factory-reset-session-stores.ts`; the persisted
`resetDiagnosticsRetentionStoreToDefaults()` is called directly from
`clearBrowserStorage()` in
`packages/app-state/src/factory-reset.ts`, alongside
its sibling persisted stores.

**Paired tests**: `packages/app-state/src/__tests__/diagnostics-retention-store.test.ts`,
`packages/app-shell/src/__tests__/diagnostics-seen-store.test.ts`,
`.../diagnostic-sink-health-store.test.ts`,
`.../diagnostics-status-item.test.tsx`, `.../use-diagnostics-purge.test.tsx`,
`.../diagnostic-sink-bridge.test.tsx` (the configured-retention startup purge
and the writer-disables-populates-health-store cases),
`packages/settings-ui/src/settings/system/logging-settings-section.test.tsx`
(retention card + sink-health banner describes).
