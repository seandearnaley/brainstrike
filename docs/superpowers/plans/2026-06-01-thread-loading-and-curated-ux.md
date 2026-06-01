# Thread Loading And Curated UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved thread loading and curated UX design as two independently reviewable PRs.

**Architecture:** PR 1 changes only the loading/error state boundary for the thread history panel and assistant thread workspace. PR 2 stores curated thread display metadata in existing Mastra thread metadata, renders it through fixed icon/color maps, and revamps thread row interactions without adding a new persistence layer.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest, Testing Library, Playwright, Chrome DevTools, PGlite-backed Mastra memory.

---

## File Structure

- `packages/app-shell/src/threads-panel.tsx`: renders the thread history panel, startup/loading/error states, row display, rename/delete, curated metadata controls, and expanded details.
- `packages/app-shell/src/assistant-thread-tabs-workspace.tsx`: renders assistant thread tab workspace and startup/loading/error states.
- `packages/app-shell/src/assistant-thread-store.ts`: persists selected/open thread state and updates Mastra-backed thread metadata in memory after repository writes.
- `packages/app-shell/src/assistant-memory-repository.ts`: validates/sanitizes thread metadata read from PGlite and persists metadata updates through existing Mastra thread rows.
- `packages/app-shell/src/__tests__/threads-panel.test.tsx`: component/integration tests for thread panel loading, metadata controls, rename/delete, and expansion.
- `packages/app-shell/src/__tests__/assistant-thread-tabs-workspace.test.tsx`: component/integration tests for assistant workspace loading/error boundaries.
- `packages/app-shell/src/__tests__/assistant-thread-store.test.ts`: store tests for metadata updates and reload/persistence behavior.
- `packages/app-shell/src/__tests__/assistant-memory-repository.test.ts`: repository tests for curated metadata validation.
- `apps/web/e2e/assistant-ui-panel.test.ts`: Playwright coverage for loading stability and thread customization flow.

## PR 1: Startup Loading States

### Task 1: ThreadsPanel Loading Boundary

**Files:**
- Modify: `packages/app-shell/src/threads-panel.tsx`
- Test: `packages/app-shell/src/__tests__/threads-panel.test.tsx`

- [ ] **Step 1: Write failing tests for initializing database state**

Add tests that mock `usePGliteDatabase()` as `null` and `useDbInitializing()` as `true`, then assert `ThreadsPanel` renders `threads-loading-card` and does not render `Failed to load threads` or `Assistant memory database unavailable`.

- [ ] **Step 2: Run test to verify red**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx
```

Expected: the new test fails because the current component renders the unavailable/error card when the repository is absent.

- [ ] **Step 3: Implement loading boundary**

Import `useDbInitializing` and `useDbProviderError` from `@brainstrike/db`. Pass `databaseInitializing` and `databaseError` into `ThreadsPanelContent`. Render loading while initializing, explicit database error when provider error exists, and unavailable only when initialization is complete and no repository exists.

- [ ] **Step 4: Verify green**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx
pnpm --filter @brainstrike/app-shell type-check
```

Expected: tests and type-check pass.

- [ ] **Step 5: Commit PR 1 loading panel change**

Commit the failing test and implementation together:

```bash
git add packages/app-shell/src/threads-panel.tsx packages/app-shell/src/__tests__/threads-panel.test.tsx
git commit -m "Fix thread panel startup loading state"
```

### Task 2: Assistant Thread Workspace Loading Boundary

**Files:**
- Modify: `packages/app-shell/src/assistant-thread-tabs-workspace.tsx`
- Test: `packages/app-shell/src/__tests__/assistant-thread-tabs-workspace.test.tsx`

- [ ] **Step 1: Write failing tests for initializing database state**

Add tests that mock `usePGliteDatabase()` as `null` and `useDbInitializing()` as `true`, then assert `AssistantThreadTabsWorkspace` renders the loading state and does not render `Assistant threads failed to load` or `Memory database unavailable`.

- [ ] **Step 2: Run test to verify red**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- assistant-thread-tabs-workspace.test.tsx
```

Expected: the new test fails because the current component treats missing repository as unavailable.

- [ ] **Step 3: Implement workspace loading boundary**

Import `useDbInitializing` and `useDbProviderError` from `@brainstrike/db`. Render loading while the database is initializing, explicit database error when provider error exists, and unavailable only after initialization completes without a repository.

- [ ] **Step 4: Verify green**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- assistant-thread-tabs-workspace.test.tsx
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx assistant-thread-tabs-workspace.test.tsx
pnpm --filter @brainstrike/app-shell type-check
```

Expected: tests and type-check pass.

- [ ] **Step 5: Commit PR 1 workspace change**

```bash
git add packages/app-shell/src/assistant-thread-tabs-workspace.tsx packages/app-shell/src/__tests__/assistant-thread-tabs-workspace.test.tsx
git commit -m "Fix assistant thread workspace startup loading state"
```

### Task 3: PR 1 Manual And Full Verification

**Files:**
- Test: `apps/web/e2e/assistant-ui-panel.test.ts`

- [ ] **Step 1: Add or tighten Playwright coverage**

Add a web E2E assertion that the assistant UI reaches thread-ready state without displaying `Failed to load threads` or `Assistant threads failed to load`.

- [ ] **Step 2: Verify Playwright coverage**

Run:

```bash
pnpm --dir apps/web exec playwright test e2e/assistant-ui-panel.test.ts --project=functional --grep "thread" --workers=1 --retries=0 --max-failures=1
```

Expected: relevant assistant thread tests pass.

- [ ] **Step 3: Run full root gate**

Run:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Expected: all commands pass together.

- [ ] **Step 4: Push PR 1 and monitor**

Push branch, create PR, start a single `gh pr checks --watch` or explicit `while true` watcher, read unresolved review threads and latest comments, address actionable feedback, and keep monitoring until merge-clean.

## PR 2: Curated Thread UX

### Task 4: Curated Metadata Contract

**Files:**
- Modify: `packages/app-shell/src/assistant-memory-repository.ts`
- Test: `packages/app-shell/src/__tests__/assistant-memory-repository.test.ts`
- Modify: `packages/app-shell/src/assistant-thread-store.ts`
- Test: `packages/app-shell/src/__tests__/assistant-thread-store.test.ts`

- [ ] **Step 1: Write failing repository tests**

Add tests proving valid `metadata.icon` and `metadata.color` load from thread rows and invalid values are omitted from the returned `AssistantMemoryThread.metadata`.

- [ ] **Step 2: Write failing store tests**

Add tests proving `updateThreadMetadata()` saves curated `icon` and `color` through the repository and updates the in-memory thread without creating a new persistence key.

- [ ] **Step 3: Run tests to verify red**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- assistant-memory-repository.test.ts assistant-thread-store.test.ts
```

Expected: tests fail because metadata does not yet validate curated icon/color.

- [ ] **Step 4: Implement metadata types and validators**

Add curated icon/color ids to `AssistantThreadMetadata`, validate them during `isThreadMetadata()`, and keep invalid metadata out of the rendered model.

- [ ] **Step 5: Verify green and commit**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- assistant-memory-repository.test.ts assistant-thread-store.test.ts
pnpm --filter @brainstrike/app-shell type-check
```

Then commit:

```bash
git add packages/app-shell/src/assistant-memory-repository.ts packages/app-shell/src/assistant-thread-store.ts packages/app-shell/src/__tests__/assistant-memory-repository.test.ts packages/app-shell/src/__tests__/assistant-thread-store.test.ts
git commit -m "Add curated thread metadata contract"
```

### Task 5: Thread Row Visual Revamp

**Files:**
- Modify: `packages/app-shell/src/threads-panel.tsx`
- Test: `packages/app-shell/src/__tests__/threads-panel.test.tsx`

- [ ] **Step 1: Write failing rendering tests**

Add tests proving the primary row shows curated icon/color/title, hides the UUID in the primary row, and still shows automatic provider/model badges.

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx
```

Expected: tests fail because the current row shows the UUID and has no curated icon/color rendering.

- [ ] **Step 3: Implement fixed icon and color maps**

Use `lucide-react` icons and fixed Tailwind class maps. Do not accept arbitrary icon names or color strings from metadata.

- [ ] **Step 4: Revamp row layout**

Render colored accent, icon, title, selected state, automatic badges, and stable action controls. Keep row dimensions stable across hover/edit/delete states.

- [ ] **Step 5: Verify green and commit**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx
pnpm --filter @brainstrike/app-shell type-check
```

Then commit:

```bash
git add packages/app-shell/src/threads-panel.tsx packages/app-shell/src/__tests__/threads-panel.test.tsx
git commit -m "Revamp assistant thread row visuals"
```

### Task 6: Metadata Editing, Rename, Delete, And Expansion

**Files:**
- Modify: `packages/app-shell/src/threads-panel.tsx`
- Test: `packages/app-shell/src/__tests__/threads-panel.test.tsx`

- [ ] **Step 1: Write failing interaction tests**

Add tests proving users can choose a curated icon/color, metadata saves through `updateThreadMetadata()`, rename errors stay next to the input, delete errors stay local to the row, and expanded details show only automatic metadata.

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx
```

Expected: tests fail because metadata edit controls and expanded automatic details do not exist.

- [ ] **Step 3: Implement metadata edit controls**

Add a compact customization popover or inline panel with icon buttons for curated icons and color swatches for curated colors. Save through `updateThreadMetadata()`.

- [ ] **Step 4: Polish rename/delete local states**

Keep icon/color context visible during rename. Keep delete confirmation destructive, disabled during progress, and locally scoped on error.

- [ ] **Step 5: Implement expanded automatic details**

Add a disclosure control that reveals provider, model, runtime kind, latest status, created/updated timestamps, reasoning/max output, and diagnostic thread id.

- [ ] **Step 6: Verify green and commit**

Run:

```bash
pnpm --filter @brainstrike/app-shell test -- threads-panel.test.tsx
pnpm --filter @brainstrike/app-shell type-check
```

Then commit:

```bash
git add packages/app-shell/src/threads-panel.tsx packages/app-shell/src/__tests__/threads-panel.test.tsx
git commit -m "Add curated thread customization controls"
```

### Task 7: PR 2 E2E, Manual, Full Verification

**Files:**
- Modify: `apps/web/e2e/assistant-ui-panel.test.ts`

- [ ] **Step 1: Write Playwright coverage**

Add coverage for choosing curated icon/color, reloading, verifying the row retains metadata, expanding automatic details, and verifying the primary row does not show the UUID.

- [ ] **Step 2: Run Playwright coverage**

Run:

```bash
pnpm --dir apps/web exec playwright test e2e/assistant-ui-panel.test.ts --project=functional --grep "thread" --workers=1 --retries=0 --max-failures=1
```

Expected: relevant assistant thread tests pass.

- [ ] **Step 3: Verify with Chrome DevTools**

Use Chrome DevTools or the in-app browser to open the local app, exercise startup, customize a thread, reload, expand details, rename, and delete. Capture screenshots or notes for the PR summary.

- [ ] **Step 4: Run full root gate**

Run:

```bash
pnpm lint && pnpm type-check && pnpm build && pnpm test
```

Expected: all commands pass together.

- [ ] **Step 5: Push PR 2 and monitor**

Push branch, create PR, start one watcher, read unresolved review threads and latest comments, address actionable feedback, and keep monitoring until merge-clean.

## Plan Self-Review

- Spec coverage: PR 1 loading states map to Tasks 1-3. PR 2 curated metadata, rename/delete, automatic expansion, persistence, and manual verification map to Tasks 4-7.
- Placeholder scan: no `TBD`, `TODO`, or unspecified follow-up tasks remain.
- Type consistency: metadata keys are consistently `icon` and `color`; persistence remains through `AssistantThreadRepository.updateThreadMetadata()`.
- Scope check: database schema, assistant runtime behavior, model catalog, and Electron main-process architectures are intentionally excluded.

