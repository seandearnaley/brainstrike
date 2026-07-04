# Turso Bootstrap Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a strict Brainstrike profile bootstrap contract, capability probe, diagnostics report, and test matrix before migrating the storage runtime from PGlite to Turso.

**Architecture:** Add a typed bootstrap report as the readiness authority, then wire current PGlite startup through it before any Turso package is selected. Desktop keeps one utility-process DB owner; web keeps a browser-worker owner. Required capabilities fail closed and are surfaced through diagnostics.

**Tech Stack:** TypeScript, Electron utility process, browser worker DB provider, PGlite current runtime, future Turso/libSQL probes, Vitest, Playwright, existing DB lane registries.

---

## File Map

Create:

- `packages/db/src/bootstrap/profile-bootstrap-report.ts` - shared report types, constructors, status helpers.
- `packages/db/src/bootstrap/profile-bootstrap-errors.ts` - typed bootstrap errors and error codes.
- `packages/db/src/bootstrap/profile-bootstrap-seeds.ts` - seed classifications and required default IDs.
- `packages/db/src/bootstrap/bootstrap-capability-probe.ts` - reusable probe runner.
- `packages/db/scripts/bootstrap-capability-probe.mts` - CLI wrapper that writes JSON and Markdown reports.
- `packages/db/__tests__/profile-bootstrap-report.test.ts` - report/error/severity tests.
- `packages/db/__tests__/bootstrap-capability-probe.test.ts` - current-runtime probe tests.

Modify:

- `packages/db/src/architecture/brainstrike-db-client-contract.ts` - align existing capability contract with bootstrap report.
- `packages/db/src/db-provider.tsx` - distinguish mounted state from bootstrap readiness and expose report.
- `apps/desktop/src/db-host-protocol.ts` - make `init` return a bootstrap report, not only `{ initialized: true }`.
- `apps/desktop/src/db-host-entry.ts` - produce report from utility-process init.
- `apps/desktop/src/db-host-manager.ts` - require and forward report.
- `apps/desktop/src/db-main.ts` - publish desktop bootstrap report and preserve current fail-fast PGlite checks.
- `apps/desktop/src/desktop-platform-diagnostics.ts` - include startup report in diagnostics.
- `packages/app-shell/src/diagnostics/system-diagnostics-panel.tsx` - render startup section.
- `packages/app-shell/src/background-indexing/workspace-index-bootstrap-service.ts` - add reportable workspace-index bootstrap status.
- `packages/app-shell/src/assistant-memory-repository.ts` - expose assistant memory schema smoke capability.
- `packages/db/scripts/db-test-lane-manifest.mjs` - register new DB tests if added as separate files.

## Task 1: Define Bootstrap Report Types

**Files:**

- Create: `packages/db/src/bootstrap/profile-bootstrap-report.ts`
- Create: `packages/db/src/bootstrap/profile-bootstrap-errors.ts`
- Test: `packages/db/__tests__/profile-bootstrap-report.test.ts`

- [ ] **Step 1: Write failing tests for required capability aggregation**

Create `packages/db/__tests__/profile-bootstrap-report.test.ts` with assertions that a required `failed` or `unknown` capability makes the report not ready.

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm --filter @brainstrike/db test -- profile-bootstrap-report
```

Expected: fail because the new report module does not exist.

- [ ] **Step 3: Implement report and error types**

Create `profile-bootstrap-report.ts` with:

- `ProfileBootstrapPhase`
- `ProfileBootstrapStatus`
- `CapabilityStatus`
- `CapabilityResult`
- `ProfileBootstrapReport`
- `createPendingBootstrapReport`
- `deriveBootstrapStatus`
- `isBootstrapReady`

Create `profile-bootstrap-errors.ts` with:

- `BootstrapConfigError`
- `BootstrapErrorCode`
- `toBootstrapDiagnosticError`

Required codes:

- `engine`
- `profile`
- `rootPath`
- `capability`
- `migration`
- `queue`
- `live`
- `providerCatalog`
- `workspaceIndex`
- `assistantMemory`

- [ ] **Step 4: Run the unit test**

Run:

```bash
pnpm --filter @brainstrike/db test -- profile-bootstrap-report
```

Expected: pass.

- [ ] **Step 5: Register lane entries if the new file is unassigned**

Run:

```bash
cd packages/db
node scripts/test-lanes.mjs check
node scripts/coverage-lanes.mjs check
```

If either command reports the new test is unassigned, add it to `packages/db/scripts/db-test-lane-manifest.mjs`.

## Task 2: Add Current-Runtime Capability Probe Library

**Files:**

- Create: `packages/db/src/bootstrap/bootstrap-capability-probe.ts`
- Create: `packages/db/scripts/bootstrap-capability-probe.mts`
- Test: `packages/db/__tests__/bootstrap-capability-probe.test.ts`

- [ ] **Step 1: Write failing report-shape tests**

Test that the probe returns a report with engine/package versions, owner, schema, vector, grep/FTS, transaction, invalidation, queue, assistant memory, and workspace index sections.

- [ ] **Step 2: Implement a current-runtime PGlite probe adapter**

The first implementation should prove the existing runtime, not Turso:

- open/close behavior;
- migration ledger status;
- vector availability;
- pg_trgm/grep migration status;
- transaction capability;
- live-query or invalidation strategy;
- queue table presence;
- assistant memory schema smoke result.

Do not add Turso packages in this task.

- [ ] **Step 3: Implement CLI output**

`packages/db/scripts/bootstrap-capability-probe.mts` should accept:

```bash
pnpm --filter @brainstrike/db bootstrap:capability-probe -- --format json --out /tmp/brainstrike-bootstrap-report.json
pnpm --filter @brainstrike/db bootstrap:capability-probe -- --format markdown --out /tmp/brainstrike-bootstrap-report.md
```

The CLI exits non-zero when any required capability is `failed` or `unknown`.

- [ ] **Step 4: Add package script**

Modify `packages/db/package.json` with:

```json
{
  "scripts": {
    "bootstrap:capability-probe": "tsx scripts/bootstrap-capability-probe.mts"
  }
}
```

- [ ] **Step 5: Verify tests and CLI**

Run:

```bash
pnpm --filter @brainstrike/db test -- bootstrap-capability-probe
pnpm --filter @brainstrike/db bootstrap:capability-probe -- --format json --out /tmp/brainstrike-bootstrap-report.json
```

Expected: tests pass and JSON report is written.

## Task 3: Make Desktop DB Host Return The Report

**Files:**

- Modify: `apps/desktop/src/db-host-protocol.ts`
- Modify: `apps/desktop/src/db-host-entry.ts`
- Modify: `apps/desktop/src/db-host-manager.ts`
- Modify: `apps/desktop/src/db-main.ts`
- Test: existing desktop DB host/main tests.

- [ ] **Step 1: Write failing protocol tests**

Update `db-host-manager`/`db-host-entry` tests so utility-process `init` must return a bootstrap report. Absence of the report should be a failed required capability, not success.

- [ ] **Step 2: Extend protocol types**

Change the `init` response from only `{ initialized: true }` to include:

- `initialized`
- `bootstrapReport`

- [ ] **Step 3: Produce report in utility host**

After the utility host opens DB, runs migrations, and verifies required current PGlite extensions, produce a report through the shared report module.

- [ ] **Step 4: Forward report through manager and `db-main` diagnostics**

Store the latest report in desktop DB mutable state and include it in diagnostics.

- [ ] **Step 5: Verify desktop unit tests**

Run focused desktop tests:

```bash
pnpm --filter @brainstrike/desktop test -- db-host-manager db-host-entry db-main
```

Expected: pass.

## Task 4: Fix Readiness Semantics In `DbProvider`

**Files:**

- Modify: `packages/db/src/db-provider.tsx`
- Test: `packages/db/__tests__/db-provider*.test*`

- [ ] **Step 1: Write failing tests**

Tests should prove:

- `ready` or a new readiness selector cannot mean DB usable after initialization failure;
- `initializationStatus === 'ready'` requires successful bootstrap report;
- missing required desktop IPC bridge in desktop mode cannot silently open direct PGlite.

- [ ] **Step 2: Add bootstrap report to context**

Extend `DbContextValue` with `bootstrapReport`.

- [ ] **Step 3: Use report-derived readiness for DB-usable state**

Keep mounted/UI state separate from database usability.

- [ ] **Step 4: Verify DB provider tests**

Run:

```bash
pnpm --filter @brainstrike/db test -- db-provider
```

Expected: pass.

## Task 5: Add Diagnostics UI And Privacy Guardrails

**Files:**

- Modify: `apps/desktop/src/desktop-platform-diagnostics.ts`
- Modify: `packages/app-shell/src/diagnostics/system-diagnostics-panel.tsx`
- Test: `apps/desktop/src/__tests__/desktop-platform-diagnostics.test.ts`
- Test: `packages/app-shell/src/__tests__/system-diagnostics-panel.test.tsx`

- [ ] **Step 1: Write failing diagnostics tests**

Tests should assert:

- startup report is included;
- failed required capability renders visibly;
- shareable diagnostics omit raw paths, filenames, content, embeddings, DB rows, prompts, provider keys, and stable hashes.

- [ ] **Step 2: Include report in desktop diagnostics**

Add `startupBootstrap` or `profileBootstrap` to the typed diagnostics payload.

- [ ] **Step 3: Render Startup section**

Add a compact diagnostics section with:

- engine/package;
- owner;
- schema version;
- vector;
- FTS/grep;
- transactions;
- invalidation;
- queue leases;
- assistant memory;
- workspace index;
- latest typed error.

- [ ] **Step 4: Verify diagnostics tests**

Run:

```bash
pnpm --filter @brainstrike/desktop test -- desktop-platform-diagnostics
pnpm --filter @brainstrike/app-shell test -- system-diagnostics-panel
```

Expected: pass.

## Task 6: Classify Seeds And Validate Fresh Profile Defaults

**Files:**

- Create: `packages/db/src/bootstrap/profile-bootstrap-seeds.ts`
- Modify: model catalog or migration tests as needed.
- Test: model catalog and workspace-index bootstrap tests.

- [ ] **Step 1: Write failing seed classification tests**

Tests should assert:

- provider/model catalog rows are migration seeds;
- view filter presets are migration seeds;
- workspace index collection is an app seed after preferences hydrate;
- roots, chunks, queues, assistant messages, observations, token cache, and run events start empty.

- [ ] **Step 2: Add seed classification module**

Include required IDs:

- `openai/gpt-5.4-mini`
- `openai/text-embedding-3-small`
- `onnx-community/gemma-4-E2B-it-ONNX`
- `Xenova/all-MiniLM-L6-v2`

- [ ] **Step 3: Make workspace-index bootstrap validate catalog availability**

The workspace index app seed must fail loudly if the required local embedding model row is missing.

- [ ] **Step 4: Verify model catalog and workspace tests**

Run:

```bash
pnpm --filter @brainstrike/db test -- model-catalog
pnpm --filter @brainstrike/app-shell test -- workspace-collection-sync-provider
```

Expected: pass.

## Task 7: Add Profile Generation Barrier For Reset

**Files:**

- Modify: `apps/desktop/src/db-main.ts`
- Modify: `apps/desktop/src/desktop-factory-reset.ts`
- Modify: queue write paths after design review.
- Test: reset and queue race tests.

- [ ] **Step 1: Write failing reset-generation tests**

Tests should prove stale workers cannot complete jobs or write vectors after reset.

- [ ] **Step 2: Add profile generation to bootstrap report**

Every boot report should include a profile generation ID.

- [ ] **Step 3: Store and check generation on queue/worker writes**

This step needs careful implementation in the queue/indexing workstream. The invariant is that stale generation writes fail closed.

- [ ] **Step 4: Verify reset tests**

Run:

```bash
pnpm --filter @brainstrike/desktop test -- desktop-factory-reset db-main.lifecycle
pnpm --filter @brainstrike/db test -- job-queue
```

Expected: pass.

## Task 8: Add Observability Tests Across Runtime Surfaces

**Files:**

- Modify: existing DB contract tests.
- Modify: existing desktop smoke startup tests.
- Modify: existing web DB worker startup tests.
- Modify: lane manifest only if new DB tests are added.

- [ ] **Step 1: Add unit contract assertions**

Required missing capability must produce `failed`, never `ok`.

- [ ] **Step 2: Add desktop smoke assertion**

Desktop app launch should assert the utility-process bootstrap report is present and required current-runtime capabilities are `ok`.

- [ ] **Step 3: Add web smoke assertion**

Web DB worker startup should assert worker-owned bootstrap report is present and required current-runtime capabilities are `ok`.

- [ ] **Step 4: Verify lane registration and focused tests**

Run:

```bash
cd packages/db
node scripts/test-lanes.mjs check
node scripts/coverage-lanes.mjs check
```

Then run the focused smoke tests used by the touched suites.

## Final Verification Gate

Run on the same commit:

```bash
pnpm lint:ci
pnpm type-check
pnpm build
pnpm test
cd packages/db && node scripts/test-lanes.mjs check && node scripts/coverage-lanes.mjs check
```

Add desktop/web smoke commands if not covered by the root gate.

## Execution Notes

Implement this before Turso package installation work. Once current PGlite bootstrapping is report-backed and fail-closed, the Turso package spike can plug into the same report and compare engines without changing the app readiness model.
