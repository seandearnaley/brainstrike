# Forest Workspace Hardening — Design Spec

> **Status:** Draft for review · **Date:** 2026-06-13 · **Author:** Claude (with Sean Dearnaley)
> **Next step after approval:** `superpowers:writing-plans` to produce a phased implementation plan. Do NOT implement from this spec directly.

**Goal:** Make the multi-root ("forest") workspace architecture fail *loudly and early* — at compile time, at a runtime assertion, or in the PR-gate smoke lane — instead of silently coercing across its three identity systems, so the class of regression that went undetected for 8 days cannot recur.

**Architecture (approach in three sentences):** The forest carries three identities for one logical root — `handle.path` (bare directory name, collides on web), the adapter-minted `RootId`, and the DB `roots.id` — joined by un-branded `string` keys at sync seams that are keyed by *path* on one side and *rootId* on the other. Every confirmed high-severity failure is a silent coercion at one of those seams. This spec brands the identity type, routes every key through one validated helper, makes the store/reconciliation/persistence seams loud, and moves the forest invariants into the PR gate.

**Tech stack:** TypeScript (strict), React 19, Zustand store, PGlite/Drizzle (DB `roots`/`file_records`), Vitest (unit), Playwright (E2E). No new dependencies.

---

## 1. Context & Motivation

Multi-root support landed across six phases (#1159 → #1193) plus identity follow-ups (#1197 same-named web roots, #1198 `source_root_path` retirement, #1200 dual-state cleanup). The features work. What is fragile is the **glue between identity layers**, and that glue currently *silently coerces* rather than throwing — in direct tension with the project's "no silent fallbacks" rule.

This was proven the hard way this session: restoring the dark nightly E2E (PR #1201) immediately surfaced forest regressions in file-explorer selection/grouping/filters that **unit tests and a five-lens adversarial review had missed**, because the actual bug lived in the *interaction* of the fixture event-bridge, the dev-fixture restore, and the reducer's dedup asymmetry — an interaction no single unit test exercised, hidden because the only forest E2E coverage lived in a nightly lane that had been cancelled for 8+ days.

**The lesson this spec encodes:** integration bugs live in subsystem interactions; defenses must be *invariants that fail fast*, not reviewer memory. Every recommendation below is grounded in current code (file:line references verified 2026-06-13).

## 2. Non-Goals

- Fixing the specific product regressions the nightly surfaced (file-explorer recursive-select/grouping/filters, embedding backfill). Those are tracked as separate task chips; this spec hardens the architecture *around* them so future regressions are caught.
- Re-architecting multi-root identity from scratch. The three-identity model is sound; we are codifying its invariants, not replacing it.
- Phase 7 product work (snapshot tier, PWA).
- Restoring the nightly E2E — **already done** (PR #1201). Referenced here only as the broad backstop behind the new smoke-lane coverage.

## 3. Design Principles

1. **Single source of truth per identity.** One value flows from adapter → reducer → DB write; the three identities must *converge*, never diverge silently.
2. **Fail loud at the seam.** A coercion at a layer boundary (path-where-rootId-expected, malformed descriptor, dropped handle) throws in dev and warns-with-count in prod. Never `logger.debug` a data-loss event.
3. **Fail fast in the PR gate.** The cheapest forest invariants run on every PR (`@web-smoke`), not only in the nightly full-regression. The nightly is a backstop, not the front line.
4. **Codify, don't comment.** An invariant enforced by a docstring ("callers MUST pass the RootId") is not enforced. Move it to the type system, a runtime assertion, or a test.
5. **Prefer invariants over defensive layers.** Per AGENTS.md — a present-but-broken guard that degrades quietly is worse than a throw that names the owner.

## 4. Problem Analysis — The Three Identities and Their Seams

```
            ┌──────────────────────────────────────────────────────────┐
            │  handle.path        bare dir name; COLLIDES for same-named │
  IDENTITY  │  RootId             adapter-minted uuidv7 (or undefined)   │
            │  roots.id (DB)      durable persistence id                 │
            └──────────────────────────────────────────────────────────┘
                 │ stamped onto handle        │ reconciled by PATH
                 ▼                             ▼
   reducer (use-file-system.ts) ◀──── ??? ────▶ DB writes (file_records.rootId)
                 the seams never exchange the reconciled id
```

**Verified facts (2026-06-13):**

- `RootId` is a bare alias: `export type RootId = string;` ([packages/types/src/file-system.ts:141](packages/types/src/file-system.ts)). A directory name in a `RootId` slot type-checks.
- `rootKeyOf(handle) = handle.rootId ?? handle.path` ([use-file-system.ts:86](packages/file-explorer-hooks/src/use-file-system.ts)). The `?? path` fallback is the latent collision: two roots both named `project` with no stamped `rootId` share a key.
- The dual-match `rootKeyOf(h) === key || h.path === …` pattern is **hand-rolled in 4 places** with a subtle asymmetry: `setRoot` (line 144), `addOrFocusHandle` (line 168, *has* the `h.rootId === undefined` guard from #1200's fix), `runMultiRootRestore` (line 286), `setFocusedRoot` (lines 482-483, **lacks** the `undefined` guard). A future edit can break same-named dedup inconsistently across these.
- `encodeFileSelection(folderId: string, path: string)` accepts any string `folderId` with no UUID validation, and has real production callers (workspace collection sync import, assistant-ui-panel-wrapper). A bare path leaking into `folderId` merges selections across same-named roots.
- Boot restore stamps handles with the **adapter** id (`stampRootId(d.handle, d.rootId)`, [use-file-system.ts:272](packages/file-explorer-hooks/src/use-file-system.ts)), while the only DB-id bridge is `resolveDbRootId(path)` in a *different* hook (`use-roots-reconciliation.ts`), keyed by path. When reconciliation converges two same-path adapter roots onto one DB row, the reducer keeps the adapter id and DB writes key by another — **`file_records` cross-talk that survives reload**, exercised by zero tests.
- Store mutations desync silently: `addActiveRoot` upserts a descriptor without clearing the stale `folderState`; `removeActiveRoot` filters with no existence check; `coerceRootDescriptors` drops malformed entries at `logger.debug` with no count.
- Partial-forest restore is invisible: only `permissionState === 'granted'` handles load; a stale handle is silently removed from cache while its DB row stays "live" and the sync gate skips that rootId — with no log or metric.
- **No E2E asserts `treegrid count === active root count`.** The `@web-smoke` lane (run on every PR) is single-root; forest coverage is `@web-file-explorer-persistence`, a non-smoke nightly lane.

## 5. Hardening Design

Organized into four phases. Each phase is independently shippable and ordered by leverage × inverse-effort. Phase 1 and the Phase 3 smoke test are the highest priority.

### Phase 1 — Codify the identity invariants (P0)

**1a. Brand `RootId`.**
Change `export type RootId = string;` to a branded type:
```ts
export type RootId = string & { readonly __brand: 'RootId' };
```
Provide one constructor `asRootId(value: string): RootId` (the single sanctioned coercion point, may validate UUID shape) and thread the branded type through `DirectoryHandle.rootId`, the `folderId` parameters, and the store maps. The compiler then rejects a bare `path` in any `RootId` position across all call sites — the mixing is caught at build time, once, instead of by reviewer memory.

*Boundary:* this is a wide but mechanical change. Expect the compiler to surface every place a raw string is used as an identity — each is a real audit point (this is the same mechanism that surfaced 4 missed store-handle consumers in #1200).

**1b. Throw at the encode seam.**
`encodeFileSelection(folderId, path)` MUST throw when `folderId` is not a valid `RootId` (UUID shape). This is the exact point where a colliding identity becomes a corrupt composite key; a throw here converts silent cross-root selection merge into a loud, located failure at the real sync-path callers.

**1c. One `findHandleByIdentity` helper.**
Collapse the 4 hand-rolled dual-match copies into:
```ts
export function findHandleByIdentity(
  identity: RootId,
  handles: readonly DirectoryHandle[],
  opts?: { allowLegacyPathFallback?: boolean }, // default false
): DirectoryHandle | null
```
The legacy `path` fallback defaults **off** and **logs a warning every time it fires**, so accidental path-keyed lookups surface in tests and field logs. This removes the `setRoot`/`addOrFocusHandle`/`setFocusedRoot`/`runMultiRootRestore` asymmetry and makes the pre-v5 path bridge auditable and removable.

**1d. Converge adapter `RootId` and DB `roots.id` at boot.**
After `adapter.restoreRoots()`, resolve each handle's `dbRootId` via the reconciliation map and stamp handles with the **reconciled DB id** (or thread the `path → dbRootId` map into the reducer so the UI identity and the write identity are the same value). This closes the deepest seam — `file_records` cross-talk that survives reload. **Highest structural leverage; touches the sync path, so it ships with an invariant test for "two same-path adapter roots converge to one DB row."**

### Phase 2 — Make the seams loud (P0/P1, mostly small)

**2a. Post-mutation store assertions.** In `addActiveRoot`/`removeActiveRoot`/`setActiveRoots`: assert (dev throw / prod warn-with-count) that every `activeRootId` has a descriptor, there is no dangling `folderState`, and `removeActiveRoot`'s target existed. On an `addActiveRoot` upsert of an existing `rootId` with a **changed path**, clear the now-stale `folderStates[rootId]` (closes the confirmed "old root's selections applied to new path" corruption).

**2b. Unconditional cross-root key cleanup.** In `removeRootDirectory`, strip every composite key prefixed with the removed `rootId` from `selectedFilePaths` and all surviving `folderStates[*].selectedFilePaths` — **independent of the `deleteRootData` option**. Today disconnect leaves stale prefixed keys that inflate union selection counts indefinitely.

**2c. Promote silent drops to observable events.** `coerceRootDescriptors` drop ([state-serialization.ts](packages/file-explorer/src/state-serialization.ts)) and the stale-handle `removeRootHandle` (web-handle-cache) move from `logger.debug` → `logger.warn` with a count, and a single boot-time forest-snapshot log records `{ persistedRoots, restoredRoots, grantedHandles }`.

### Phase 3 — Fail fast in CI (P0/P1)

**3a. `@web-smoke` forest invariants (the top quick win).** Add an E2E, tagged `@web-smoke` so it runs on every PR:
- `getByRole('treegrid', { name: 'File tree' })` count **=== active root count** (one assertion; closes the entire duplicate/missing-tree class — would have caught the 8-day bug the same hour).
- A 2-granted-roots restore scenario (add two roots → reload → both restore as exactly two distinct trees).

**3b. Forest characterization suite (unit + smoke).** Codify the invariants:
- `addRoot(N)` ⇒ exactly N handles, no duplicates.
- Two same-named roots stay distinct through add → select → remove → restore, with **no selection bleed** between them.
- The fixture-inject-unstamped-then-adapter-restore-stamped same-path race reconciles to **one** root (the exact #1200 regression).

Move the 2-3 core forest scenarios out of the nightly `@web-file-explorer-persistence` lane into a PR-gated `@web-forest` (or fold into `@web-smoke`).

### Phase 4 — Persistence lifecycle (P2)

**4a. Explicit handle-valid lifecycle.** Add `roots.handle_valid` (or `status`) written `false` when `queryPermission` throws on restore, plus a boot reconciliation pass that, for each DB `rootId` with no live handle, re-checks `restoreRoots` and marks `reconnected`/`disconnected`. Differentiate `NotFoundError` (folder deleted) from permission-denied in the restore banner so transient remounts (USB/network share) recover instead of being conflated with deletion.

**4b. Migration 040 backfill observability.** Add a pre-scan that counts and logs `file_records` rows whose `source_root_path` matched no `roots.path` and were left `root_id NULL` (dropped from the managed cache), plus a test for the mixed matched/unmatched case where a 039 insert failed. Turns silent legacy data loss into a diagnosable event.

## 6. Invariants Catalog

The system will enforce these invariants, each by a concrete mechanism (not a comment):

| # | Invariant | Enforcement | Location |
|---|-----------|-------------|----------|
| I1 | A `RootId` is never a bare directory path | Compile-time (branded type) + `asRootId` constructor | types/file-system.ts; all identity call sites |
| I2 | A composite selection key's `folderId` is a valid `RootId` | Runtime throw | `encodeFileSelection` |
| I3 | Handle lookups use `RootId`; path fallback is opt-in and logged | Centralized helper + warn-on-fallback | `findHandleByIdentity` |
| I4 | UI-state rootId == DB-write rootId for every root | Reconcile-at-boot + invariant test | boot restore + reconciliation map |
| I5 | Every `activeRootId` has a descriptor; no dangling `folderState` | Post-mutation assertion (dev throw/prod warn) | `active-root-actions.ts` |
| I6 | No surviving selection key references a removed root | Unconditional cleanup | `removeRootDirectory` |
| I7 | A partially-offline forest is observable | warn-with-count + boot snapshot log + user signal | restore path, sync gate, handle cache |
| I8 | `treegrid count === active root count` | `@web-smoke` E2E | new forest smoke test |
| I9 | Same-named roots never bleed selection/focus | characterization suite (unit + smoke) | new `@web-forest` tests |

## 7. Test Strategy

- **Unit (Vitest):** extend `use-file-system.test.ts` with forest (>1 root) characterization covering I1–I6, I9. Each invariant gets a test that *fails before* its enforcement lands (TDD).
- **E2E (Playwright):** I8 + I9 core scenarios in `@web-smoke` (PR gate). Broader restore/permission matrices stay in the now-restored nightly full-regression as the backstop.
- **Migration (db `__tests__`):** I-040 mixed matched/unmatched backfill case; register the new test file in **both** `test-lanes.mjs` and `coverage-lanes.mjs` per the model-catalog-migration rule (a new `packages/db/__tests__` file unassigned in either lane breaks a CI job).
- **CI parity:** the whole suite (build, types, lint, unit, smoke E2E) must pass green in one run before merge.

## 8. Observability Design

A single structured logger scope (`createLogger('Forest')`) emits on: root add/focus/remove/dedup/rekey, partial restore (`N of M folders need reconnection`), and every legacy-path-fallback hit. Boot emits one forest-snapshot line. No event that represents data loss or desync is below `warn`. This makes a field desync forensically reconstructable instead of invisible until a user reports a ghost/duplicate root.

## 9. Rollout / Staging

Recommended PR series (each independently green, ordered by dependency and risk):

1. **PR A — Phase 3a smoke invariant (I8) first.** Lands the safety net *before* the refactors it protects, on the PR gate. Cheapest, highest immediate leverage.
2. **PR B — Phase 1a/1b/1c (brand + encode-throw + helper, I1-I3).** The wide mechanical identity change; the compiler drives the audit. Phase 3b characterization tests land alongside.
3. **PR C — Phase 1d (reconcile adapter↔DB id, I4).** The deep sync-path change; isolated so it can be reverted independently and watched on the (now-live) nightly.
4. **PR D — Phase 2 (loud seams, I5-I7).** Store assertions, key cleanup, observability.
5. **PR E — Phase 4 (persistence lifecycle, I-040).** Lowest urgency; bites legacy/edge cases.

## 10. Risks & Mitigations

- **R1: Branding `RootId` is a large diff.** *Mitigation:* it is mechanical and compiler-guided; land it as its own PR (B) so the audit is reviewable. The encode-throw (I2) is the runtime backstop for anything the types miss.
- **R2: Reconciling adapter↔DB id (1d) touches the live indexing write path.** *Mitigation:* ship behind the I4 invariant test + the converging-same-path test; isolate in PR C; watch the restored nightly. This is the one change that warrants extra care.
- **R3: New dev-mode assertions could throw on pre-existing dirty persisted state.** *Mitigation:* dev throws / prod warns-with-count; pair each assertion with a one-time self-heal on hydration (mirrors the existing `mergeActiveRoots` load-time filter).
- **R4: Smoke-lane time budget.** *Mitigation:* the forest smoke tests are few and fast; they replace, not add to, the value previously expected from the (dark) nightly.

## 11. Open Questions

1. **Identity convergence direction (I4):** stamp handles with the DB id, or thread the `path→dbRootId` map into the reducer and keep the adapter id as a transient? (Affects how invasive PR C is.)
2. **Legacy path fallback removal:** can `allowLegacyPathFallback` be removed entirely after a deprecation window, or is there a real pre-v5 persisted-state path that still needs it?
3. **`status` vs `handle_valid` (4a):** a boolean or a small enum (`live`/`disconnected`/`deleted`)? The banner UX (revocation vs deletion) argues for the enum.
4. **Scope of branding:** brand only `RootId`, or also `CollectionId`/other ids that share the same bare-string-collision risk?

## 12. Self-Review Notes

- *Placeholder scan:* none — every recommendation cites a concrete file/symbol verified 2026-06-13.
- *Internal consistency:* the invariant catalog (§6) maps 1:1 to the phases (§5) and the staging (§9); no orphan invariants.
- *Scope:* focused on hardening (invariants, observability, test placement); product-regression fixes explicitly deferred (§2).
- *Ambiguity:* the four genuine design forks are surfaced as open questions (§11) rather than silently decided.
