# Flight Recorder P2b — Status Chip, Retention Settings, Sink-Health Banner

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Close out §9 of the design — make background errors *visible* (a status-bar chip), *manageable* (retention settings + Purge now), and make a broken sink *loud* (health banner).

**Architecture:** Two session stores (unseen watermark, sink health) and one persisted store (retention prefs) in the existing store idioms. The chip is a hand-rolled status-bar button (the shared `StatusBarItem` has no `onClick`) driven by a `COUNT(*)` live query. The settings section gains a retention card whose Purge/retention values reach the repository through callback props — never a repository import into `packages/preferences` (that direction is circular).

**Stack:** This branch is stacked on `claude/flight-recorder-p2-backstop-viewer` (PR #1970). **Land P2a first**, then this. Do not delete the P2a branch before retargeting this one (a `--delete-branch` on a stack bottom permanently closes dependents).

**Spec:** `docs/error-observability-design-2026-07-23.md` §9 bullets 2 and 3, plus the §4.3 sink-health surface.

## Global Constraints

- TypeScript strict, never `any`. Kebab-case files; hooks `use-*.ts`.
- NO SILENT FALLBACKS: a failed purge surfaces via toast; a disabled sink surfaces via the banner; never an empty state that reads as healthy.
- Capability gating by composition (db handle), never `isElectron()`.
- **`packages/preferences` must NOT import from `packages/app-shell`** — app-shell depends on preferences, so anything needing the repository is a callback prop supplied by each app's page-content (the P2a `onExportDurableNdjson` precedent).
- The diagnostic sink's own records are excluded from capture by the `DIAGNOSTIC_SINK_SCOPE` loop guard, so **`onDisabled` is the only signal a broken sink emits** — it must reach the UI out-of-band via a module-level store (the bridge mounts outside `RootLayoutContent`, so React context cannot carry it).
- Object keys alphabetized (Biome `useSortedKeys` is enforced repo-wide).
- `pnpm dlx ultracite fix` before committing; bar is build + lint + type-check + test green in one run.
- react-doctor: no non-component exports from `.tsx`; avoid `try/finally` in components (the React Compiler cannot lower a finalizer — this exact rule failed a required check on P2a).

## File Structure

```
packages/preferences/src/stores/diagnostics-retention-store.ts   # persisted: maxAgeDays, maxRows
packages/preferences/src/settings/system/factory-reset-helpers.ts # (modify) direct reset call
packages/app-shell/src/diagnostics/diagnostics-seen-store.ts     # session: unseen watermark
packages/app-shell/src/diagnostics/diagnostic-sink-health-store.ts # session: disabled + cause
packages/app-shell/src/register-factory-reset-session-stores.ts  # (modify) register both
packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx    # (modify) onDisabled -> store; configured purge
packages/app-shell/src/diagnostics/use-unseen-diagnostics-count.ts # COUNT live query hook
packages/app-shell/src/status-items/diagnostics-status-item.tsx  # the chip
packages/app-shell/src/status-items/index.ts                     # (modify) export
packages/app-shell/src/app-layout.tsx                            # (modify) mount in rightContent
packages/preferences/.../logging-settings-section.tsx            # (modify) retention card + banner
apps/web/src/app/settings/page-content.tsx                       # (modify) pass onPurgeNow
apps/desktop/src/renderer/components/settings/logging-settings.tsx # (modify) pass onPurgeNow
```

---

### Task 1: Persisted retention preferences store

**Files:** Create `packages/preferences/src/stores/diagnostics-retention-store.ts`. Modify `packages/preferences/src/settings/system/factory-reset-helpers.ts`. Test: `packages/preferences/src/__tests__/diagnostics-retention-store.test.ts`.

Copy the shape of `packages/preferences/src/stores/notification-preferences-store.ts` **exactly** (zustand `createWithEqualityFn` + `persist`, `createJSONStorage(() => createBrowserJsonStorage())`, split Data/Actions interfaces, `partialize`, sanitizing `migrate`, exported plain-object selectors, a `reset…ToDefaults()` and a test alias).

**Interfaces:**
```ts
export interface DiagnosticsRetentionData { maxAgeDays: number; maxRows: number }
// defaults: maxAgeDays 30, maxRows 20_000 — must equal the repository's
// DIAGNOSTIC_RETENTION_MAX_AGE_MS / _MAX_ROWS so behavior is unchanged until a user edits it.
export const DIAGNOSTICS_RETENTION_DAY_OPTIONS = [7, 14, 30, 90] as const;
export const DIAGNOSTICS_RETENTION_ROW_OPTIONS = [5_000, 20_000, 50_000] as const;
export function resetDiagnosticsRetentionStoreToDefaults(): void;
export const diagnosticsRetentionSelectors: { maxAgeDays; maxRows };
```
Setters must REJECT (throw) a value outside the allowed option lists rather than coercing — malformed config is loud (no-silent-fallbacks). `migrate` sanitizes an unknown persisted payload back to defaults.

Factory reset: add a direct `resetDiagnosticsRetentionStoreToDefaults()` call inside `clearBrowserStorage()` in `factory-reset-helpers.ts`, in the existing run of sibling `try/catch` blocks (match `resetNotificationPreferencesStoreToDefaults`'s block verbatim, including the explanatory comment style).

- [ ] Failing tests: defaults equal the repository constants (import them to assert equality, don't hardcode twice); a valid setter updates; an out-of-range setter throws; `migrate` on a garbage payload yields defaults; `reset…ToDefaults` restores defaults and clears persisted storage; a factory-reset test asserting the store is reset (extend the existing factory-reset test file — find it: `grep -rn "resetNotificationPreferencesStoreToDefaults" packages/preferences/src/__tests__`).
- [ ] Run → FAIL. Implement → PASS. Whole package green.
- [ ] `ultracite fix`; commit `feat(diagnostics): persisted retention preferences store`.

---

### Task 2: Session stores — unseen watermark + sink health

**Files:** Create `packages/app-shell/src/diagnostics/diagnostics-seen-store.ts` and `packages/app-shell/src/diagnostics/diagnostic-sink-health-store.ts`. Modify `packages/app-shell/src/register-factory-reset-session-stores.ts` and `packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx`. Tests: `packages/app-shell/src/__tests__/diagnostics-seen-store.test.ts`, `.../diagnostic-sink-health-store.test.ts`.

Plain `create` zustand (NO persist — both are session state), each exporting a module-level `reset…Store()` wrapper, both registered in `register-factory-reset-session-stores.ts` with a comment explaining why they are session-only.

**`diagnostics-seen-store.ts`:**
```ts
// The watermark is SESSION-scoped by design (design §9): it is seeded at first
// mount, so the chip counts "warn+ events since this launch" rather than
// replaying every retained row as unread on every restart.
export interface DiagnosticsSeenState { lastSeenAtMs: number; markAllSeen(nowMs: number): void }
export function resetDiagnosticsSeenStore(): void;
```
Seed `lastSeenAtMs` to `Date.now()` at store creation.

**`diagnostic-sink-health-store.ts`:**
```ts
export interface DiagnosticSinkHealthState {
  disabledReason: string | null;
  markDisabled(reason: string): void;   // idempotent: first reason wins
  clear(): void;
}
export function resetDiagnosticSinkHealthStore(): void;
```

**Bridge change:** in `diagnostic-sink-bridge.tsx`'s `onDisabled` callback, keep the existing `bridgeLogger.error(...)` AND additionally call `markDisabled(...)` with the same bounded reason string. Import the store by direct file path (not a barrel) so the side-effect graph stays small.

- [ ] Failing tests: seen store seeds to "now" and `markAllSeen` advances it; health store records the first reason and ignores later ones, `clear()` resets; both reset functions restore initial state; a bridge test asserting that a writer whose sink always rejects eventually populates the health store (extend `diagnostic-sink-bridge.test.tsx`, driving enough failed flushes to trip `maxConsecutiveFailures`).
- [ ] Run → FAIL. Implement → PASS.
- [ ] `ultracite fix`; commit `feat(diagnostics): session stores for unseen count and sink health`.

---

### Task 3: Unseen-count hook + status-bar chip

**Files:** Create `packages/app-shell/src/diagnostics/use-unseen-diagnostics-count.ts` and `packages/app-shell/src/status-items/diagnostics-status-item.tsx`. Modify `packages/app-shell/src/status-items/index.ts` and `packages/app-shell/src/app-layout.tsx`. Test: `packages/app-shell/src/__tests__/diagnostics-status-item.test.tsx`.

**Hook:**
```ts
export function useUnseenDiagnosticsCount(): { count: number; error: Error | null };
```
Uses `usePGliteLiveQuery` with
`SELECT COUNT(*)::int AS count FROM brainstrike_diagnostic_events WHERE occurred_at > $1`
— note the table's CHECK constraint means every row is already warn+, so no severity predicate is needed (say so in a comment; a redundant filter invites someone to "fix" it later). Bind the watermark as an **ISO string** (repo convention — `new Date(ms).toISOString()`), and include it in `cacheKey: makeLiveQueryKey('diagnostics-unseen', iso)` because a `cacheKey` skips deep param comparison, so every param must appear in it. `params` must be a stable reference (`useMemo`). Gate with `enabled` on the db handle being present.

> **BST-1222 amendment (2026-08-10):** the shipped contract now uses two
> aggregate `FILTER` clauses to partition the CHECK-constrained warn+ set for
> honest labels. `warn` remains a warning; `error` and `fatal` share the error
> bucket. This supersedes the original no-predicate instruction above without
> changing which rows qualify.

**Caveat to verify first:** `usePGliteLiveQuery` internally calls the NON-optional `usePGliteDatabase()`. `AppLayout` renders inside `<DbProvider>` on both platforms, but confirm the non-optional hook's behavior before the handle is ready; if it throws, gate the chip so the hook is not called until a handle exists (split the querying part into a child component rendered only when `useOptionalPGliteDatabase()` is non-null). Report which you did.

**Chip:** `DiagnosticsStatusItem` renders `null` when `count === 0` (no chrome when there is nothing wrong). Otherwise a hand-rolled `<button>` — the shared `StatusBarItem` has no `onClick` — copying `indexing-status-item.tsx`'s exact accessibility shape: a separate `sr-only` live region sibling, `aria-label` on the button, visible content `aria-hidden`. Amber tone (`text-amber-800 dark:text-amber-300`, matching that file's palette). Label: the count plus "error"/"errors". `data-testid="diagnostics-status-trigger"`.

On click: `markAllSeen(Date.now())`, then `openSettings()` and `window.location.hash = '#settings/logging'` — the precedent is `packages/app-shell/src/assistant-ui-panel-wrapper.tsx:703-708`. `openSettings` comes from the panel-layout store. Mount in `app-layout.tsx`'s `rightContent`, before `<IndexingStatusItem />`, importing by direct file path like its siblings.

- [ ] Failing tests: renders nothing at count 0; renders the count and correct singular/plural at 1 and 2; clicking marks seen (watermark advances) and sets the hash to `#settings/logging` and calls `openSettings`; a query error still renders honestly rather than silently showing 0 (decide and pin the behavior — surfacing the chip in a warning state with an error label is acceptable; showing 0 is not).
- [ ] Run → FAIL. Implement → PASS. Then `pnpm turbo run type-check test --filter=@brainstrike/app-shell`.
- [ ] `ultracite fix`; commit `feat(diagnostics): unseen-error status bar chip`.

---

### Task 4: Retention settings card + Purge now

**Files:** Modify `packages/preferences/src/settings/system/logging-settings-section.tsx`, `apps/web/src/app/settings/page-content.tsx`, `apps/desktop/src/renderer/components/settings/logging-settings.tsx`, and `packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx` (startup purge uses configured values). Tests: extend the section test; extend the bridge test.

**Section:** add `onPurgeNow?: () => Promise<number>` to `LoggingSettingsSectionProps` (callback prop — do NOT import the repository here; that direction is circular, same reason as `onExportDurableNdjson`). Render a **Diagnostics Retention** card only when `onPurgeNow` is present, after `AdvancedLoggingCard`, matching `GeneralLoggingCard`'s composition (Card → CardHeader/Title/Description → CardContent `space-y-4`, a `grid gap-4 md:grid-cols-2` of labelled Selects, then a bordered action row for Purge now mirroring the Restore Defaults row exactly: `size="sm" type="button" variant="outline"` + a lucide icon `className="mr-2 h-4 w-4"` `aria-hidden="true"`).
- Two Selects bound to the Task 1 store (`maxAgeDays` from `DIAGNOSTICS_RETENTION_DAY_OPTIONS`, `maxRows` from `DIAGNOSTICS_RETENTION_ROW_OPTIONS`).
- Purge now: disabled while in flight (local state, **no `try/finally`** — reset the flag in both the success and catch paths; a finalizer breaks the React Compiler and failed a required check on P2a). On success toast the deleted count ("Purged N diagnostic events"); on failure a destructive toast naming the error. Note the repository's per-call `limit` means one purge may not fully drain a large backlog — if the returned count equals the per-call limit, say so in the toast rather than implying completion.

**Apps:** build `onPurgeNow` from the repository (`new DiagnosticEventsRepository(db).purge({maxAgeMs, maxRows})` with the store's configured values) and pass it, gated on a db handle. Follow the `{...(x === undefined ? {} : { x })}` spread idiom (`exactOptionalPropertyTypes` is on).

**Bridge:** the startup purge currently calls `repository.purge()` with no arguments (defaults). Change it to read the configured values from the Task 1 store so a user's retention choice actually takes effect. Keep the existing error logging.

- [ ] Failing tests: card absent without `onPurgeNow`, present with it; changing a Select writes the store; Purge now calls the callback, toasts the count on success and a destructive toast on failure, and is disabled while in flight; the bridge's startup purge passes the configured values (assert the args).
- [ ] Run → FAIL. Implement → PASS. Then `pnpm turbo run type-check test` across app-shell, preferences, web, desktop.
- [ ] `ultracite fix`; commit `feat(settings): diagnostics retention controls and purge`.

---

### Task 5: Sink-health banner

**Files:** Modify `packages/preferences/src/settings/system/logging-settings-section.tsx` and both app wirings. Test: extend the section test.

Add `sinkHealthReason?: string | null` to `LoggingSettingsSectionProps`. When non-null, render an amber banner at the TOP of the section (above `GeneralLoggingCard`) reusing the existing amber style already in this file (`FileLoggingCard`'s `rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-amber-900 text-xs dark:text-amber-200`). Copy must state plainly that durable diagnostic capture is stopped, name the reason, and say a restart re-enables it — this is the §4.3 honest-degradation surface. Each app reads the Task 2 health store and passes the value.

- [ ] Failing tests: no banner when the reason is null; banner with the reason text when set; it renders above the general card.
- [ ] Run → FAIL. Implement → PASS.
- [ ] `ultracite fix`; commit `feat(settings): surface a disabled diagnostic sink`.

---

### Task 6: Docs + full verification

- [ ] `docs/agents/platform-contracts.md`, DIAGNOSTIC EVENTS section: document the chip (session watermark seeded at launch — and why: a persisted watermark would replay every retained row as unread on restart), the retention prefs (defaults must track the repository constants; setters throw on out-of-range), the purge path (per-call `limit` means one press may not fully drain), and the sink-health surface (`onDisabled` is the ONLY signal because the loop guard keeps sink errors out of the table; it travels via a module-level store because the bridge mounts outside `RootLayoutContent`). Record the factory-reset wiring for all three stores.
- [ ] `docs/error-observability-design-2026-07-23.md`: status line → `Status: P1 + debug bundle + P2a + P2b IMPLEMENTED; P3 / P5 pending.`
- [ ] Full verification in one session: `pnpm build && pnpm lint && pnpm type-check && pnpm test` (run separately, foreground, generous timeouts). Also run react-doctor and confirm no NEW error-severity findings.
- [ ] Commit `docs: platform contract for the diagnostics chip, retention, and sink health`. Do NOT push (controller pushes and opens the stacked PR).

## Self-Review (at plan-writing time)

- **Spec coverage:** §9 bullet 2 (chip) → T2/T3; §9 bullet 3 (retention, purge, banner) → T1/T4/T5; §4.3 sink health → T2/T5. §9 bullet 1's richer viewer filters (source/code/time-range, row detail, per-row copy) remain deferred and are recorded as such in P2a's docs — not in this phase.
- **Verify-first points flagged inline:** `usePGliteLiveQuery`'s non-optional db hook inside the status bar; the existing factory-reset test file's location; whether `openSettings` is reachable from a status item's render tree.
- **Cross-task types:** `DiagnosticsRetentionData` (T1) is read by T4's card and T4's bridge change; `markAllSeen`/`lastSeenAtMs` (T2) feed T3's hook; `disabledReason` (T2) feeds T5.
