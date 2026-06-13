# Dual-State Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-duplicate the two `RuntimeData` type clusters (agent extends the dependency-light contract) and make the root-folder reducer the sole live-handle owner with a hardened (no-silent-fallback) reducer↔store sync seam — all behavior-preserving.

**Architecture:** Part 1 is type-only: `@brainstrike/agent`'s `RuntimeData` `extends` `@brainstrike/assistant-contract`'s canonical base, overriding only the AI-SDK/Mastra-bound fields. Part 2 removes the store's duplicate `rootDirectoryHandle` cache (rerouting the inline-fixture's non-React injection through a `brainstrike:inject-root-handle` CustomEvent into the reducer), makes the 3 store-sync callbacks required, and drops a redundant focus-write.

**Tech Stack:** TypeScript (strict), React 19, Zustand, Vitest. pnpm workspaces. Per-package: `pnpm test` (vitest run), `pnpm type-check` (tsc --noEmit). Full gate: `pnpm check`.

**Spec:** `docs/superpowers/specs/2026-06-13-dual-state-refactor-design.md`

**Working dir:** worktree `worktree-dual-state-refactor` (isolated from the parallel session). All paths below are repo-relative.

---

## File Structure

| File | Change |
| --- | --- |
| `packages/agent/src/types.ts` | `RuntimeData` → `extends Omit<ContractRuntimeData, 'providerOptions'\|'memory'>` + 3 server fields; delete 7 identical supporting types, re-export them from contract; keep `RuntimeProviderOptions`(+sub-options/enums) and `RuntimeMemoryContext`. |
| `packages/agent/src/__tests__/runtime-data-contract.test-d.ts` *(new)* | Type-level assignability assertion (agent `RuntimeData` ⊇ contract). |
| `packages/file-explorer-hooks/src/use-file-system.ts` | Make `addActiveRoot`/`removeActiveRoot`/`setActiveRoots` required; drop the silent `typeof === 'function'` guards (`:292,341,386,397,448,534`); drop the context's redundant focus-write coupling. |
| `packages/file-explorer-ui/src/setup-inline-fixture-subscription.ts` | Replace `store.getState().setRootDirectoryHandle(...)` with `brainstrike:inject-root-handle` CustomEvent dispatch; track last handle locally. |
| `packages/file-explorer-ui/src/shell/use-file-system-context.ts` | Add inject-root-handle listener → reducer; remove store-handle selectors, the 6 store-handle writes, the one-way layout sync; return `coreApi.rootDirectoryHandle`; drop redundant 2nd focus-write. |
| `packages/file-explorer/src/store.ts` | Remove `rootDirectoryHandle` initial value + `setRootDirectoryHandle` action. |
| `packages/types/src/file-explorer-types.ts` | Remove `rootDirectoryHandle` field (`:394-395`) + `setRootDirectoryHandle` method type (`:448`) from `FileExplorerState`. |
| Tests: `packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts`, `packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts` (+ fixture-subscription test) | Characterization first, then assert new behavior. |

**Out of scope (do not touch):** `packages/file-explorer-ui/src/hooks/use-inline-fixture-effect.ts` (dead code — flag for separate cleanup).

---

## Phase A — Part 1: `RuntimeData` dedup

### Task A1: agent `RuntimeData` extends contract; unify identical supporting types

**Files:**
- Modify: `packages/agent/src/types.ts`
- Create: `packages/agent/src/__tests__/runtime-data-contract.test-d.ts`
- Verify: `packages/agent/src/index.ts` (re-export `from './types'` keeps working — no edit expected)

- [ ] **Step 1: Write the type-level assignability assertion (new file)**

```ts
// packages/agent/src/__tests__/runtime-data-contract.test-d.ts
import type { RuntimeData as ContractRuntimeData } from '@brainstrike/assistant-contract';
import { describe, expectTypeOf, it } from 'vitest';
import type { RuntimeData } from '../types';

describe('RuntimeData contract alignment', () => {
  it('agent RuntimeData satisfies the contract base for shared fields', () => {
    // Every contract field must remain assignable from the agent type so the UI
    // contract and the runtime type never drift (the old "keep in sync" comment).
    expectTypeOf<RuntimeData>().toMatchTypeOf<
      Omit<ContractRuntimeData, 'providerOptions' | 'memory'>
    >();
  });

  it('agent RuntimeData keeps its server-only fields', () => {
    expectTypeOf<RuntimeData>().toHaveProperty('localLlmHostClient');
    expectTypeOf<RuntimeData>().toHaveProperty('mastraTools');
    expectTypeOf<RuntimeData>().toHaveProperty('mcpConfig');
  });

  it('agent RuntimeData provider union includes local (inherited from contract)', () => {
    expectTypeOf<RuntimeData['provider']>().toMatchTypeOf<'local' | undefined | (string & {})>();
  });
});
```

- [ ] **Step 2: Run the type test against the CURRENT code to confirm it compiles**

Run: `cd packages/agent && pnpm vitest run src/__tests__/runtime-data-contract.test-d.ts`
Expected: PASS (the two shapes are currently independent but structurally aligned for shared fields; if `provider`'s missing `'local'` makes the 3rd assertion fail, that documents the latent gap — note it and proceed; Step 3 fixes it).

- [ ] **Step 3: Edit `packages/agent/src/types.ts` — extend + unify**

Replace the standalone `RuntimeData` interface (lines 68–146) and the duplicate supporting-type declarations (`RuntimeWorkspaceContextRangeMetadata`, `RuntimeWorkspaceContextFileMetadata`, `RuntimeWorkspaceIndexStatusState`, `RuntimeWorkspaceIndexQueueProgress`, `RuntimeWorkspaceContextMetadata`, `RuntimeMemoryContext`'s NON-divergent siblings `RuntimeAgentLoopSettings`, `RuntimeModelSettings`) as follows. KEEP `RuntimeProviderOptions` (+ `OpenAiProviderOptions`, `AnthropicProviderOptions`, `GoogleProviderOptions`, `LocalProviderOptions`, `LocalRuntimeProviderOptions`, the reasoning/effort/thinking enums) and `RuntimeMemoryContext` (Mastra-bound) declared in this file.

At the top of `types.ts`, add to the import block:

```ts
import type {
  RuntimeAgentLoopSettings,
  RuntimeData as ContractRuntimeData,
  RuntimeModelSettings,
  RuntimeWorkspaceContextFileMetadata,
  RuntimeWorkspaceContextMetadata,
  RuntimeWorkspaceContextRangeMetadata,
  RuntimeWorkspaceIndexQueueProgress,
  RuntimeWorkspaceIndexStatusState,
} from '@brainstrike/assistant-contract';
```

Re-export the 7 unified types (so `agent/index.ts`'s `from './types'` re-export keeps resolving them):

```ts
// These 7 are byte-identical and dependency-free in both packages; the
// dependency-light contract owns them. agent re-exports for API stability.
export type {
  RuntimeAgentLoopSettings,
  RuntimeModelSettings,
  RuntimeWorkspaceContextFileMetadata,
  RuntimeWorkspaceContextMetadata,
  RuntimeWorkspaceContextRangeMetadata,
  RuntimeWorkspaceIndexQueueProgress,
  RuntimeWorkspaceIndexStatusState,
} from '@brainstrike/assistant-contract';
```

Replace the `RuntimeData` interface with:

```ts
export interface RuntimeData extends Omit<ContractRuntimeData, 'providerOptions' | 'memory'> {
  /**
   * Provider-specific runtime options. Agent keeps the AI-SDK-bound shape
   * (`@ai-sdk/provider` SharedV2/V3ProviderOptions) — it intentionally diverges
   * from the contract's dependency-free mirror, so the contract package stays
   * free of the AI-SDK dependency. Do NOT move this to assistant-contract.
   */
  providerOptions?: RuntimeProviderOptions;
  /**
   * Mastra memory context. Agent keeps the Mastra-bound `memoryOptions`
   * (`AgentMemoryOption['options']`) — diverges from the contract mirror for the
   * same dependency-isolation reason. Do NOT move this to assistant-contract.
   */
  memory?: RuntimeMemoryContext;
  /**
   * Host-injected client that proxies built-in local LLM inference. Server-side
   * only, never serialized over IPC/HTTP. Agent-only.
   */
  localLlmHostClient?: LocalLlmHostClient;
  /** Mastra agent tools registry. Agent-only. */
  mastraTools?: ToolsInput;
  /** MCP server configuration. Agent-only. */
  mcpConfig?: McpConfig;
}
```

Delete the now-unused local declarations of the 7 unified types AND their JSDoc from `types.ts`. KEEP everything `RuntimeProviderOptions`-related and `RuntimeMemoryContext`. Remove the now-stale `imports` only if a deleted type was their sole consumer (e.g. `RuntimeAssistantMemorySettings` is still used by `RuntimeMemoryContext`, so KEEP it; verify with the type-check).

- [ ] **Step 4: agent type-check**

Run: `cd packages/agent && pnpm type-check`
Expected: PASS (0 errors). If `index.ts` reports a missing re-export, confirm `types.ts` re-exports it from contract.

- [ ] **Step 5: Run the type test + the agent unit suite**

Run: `cd packages/agent && pnpm vitest run src/__tests__/runtime-data-contract.test-d.ts && pnpm test`
Expected: type test PASS (all 3 assertions, incl. `'local'`); full agent suite PASS.

- [ ] **Step 6: Downstream type-check (consumers of the agent RuntimeData)**

Run: `cd packages/app-shell && pnpm type-check && cd ../../apps/desktop && pnpm type-check`
Expected: PASS. (app-shell imports the contract `RuntimeData`; desktop imports the agent one — both must still compile.)

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/__tests__/runtime-data-contract.test-d.ts
git commit -m "refactor(agent): RuntimeData extends the assistant-contract base

Unify the 7 identical, dependency-free supporting types (canonical in
assistant-contract; agent re-exports). agent RuntimeData now extends
Omit<ContractRuntimeData,'providerOptions'|'memory'> + the 3 server-only fields,
keeping the AI-SDK/Mastra-bound providerOptions+memory in agent. Inheriting
provider closes the latent 'local' gap. Deletes the keep-in-sync drift hazard."
```

---

## Phase B — Part 2: root-handle state hardening

### Task B1: Characterization tests (pin current behavior BEFORE refactoring)

**Files:**
- Modify: `packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts`
- Modify/inspect: `packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts`

- [ ] **Step 1: Read both existing test files** to learn the harness (mock adapter shape, how the store actions are stubbed). Do not change behavior — add characterization coverage where missing for: (a) `addRootDirectory` calls `addActiveRoot` when `persisted`; (b) `removeRootDirectory` calls `removeActiveRoot` after the focus shift; (c) restore calls `setActiveRoots`; (d) the context returns the focused handle. These pin the contracts B3/B4 must preserve.

- [ ] **Step 2: Run the existing suites to establish the green baseline**

Run: `cd packages/file-explorer-hooks && pnpm test` then `cd ../file-explorer-ui && pnpm test`
Expected: PASS (baseline). Record counts.

- [ ] **Step 3: Commit any added characterization tests**

```bash
git add packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts
git commit -m "test(file-explorer): characterize root-handle sync before refactor"
```

### Task B2: Required store-sync callbacks (no silent no-ops)

**Files:**
- Modify: `packages/file-explorer-hooks/src/use-file-system.ts`

- [ ] **Step 1: Write/extend a failing test** asserting that an absent store-sync dep is a programming error. In `use-file-system.test.ts`, add a test that renders `useFileSystem` WITHOUT `addActiveRoot` and expects a TypeScript-required failure surfaced at runtime — since required props can't be omitted in TS, instead assert the POSITIVE: with all deps present, `addRootDirectory` (persisted) calls `addActiveRoot` exactly once, and `removeRootDirectory` calls `removeActiveRoot` exactly once (these replace the silently-guarded paths). Run it against current code: PASS (already true) — this is the regression guard for the guard-removal.

Run: `cd packages/file-explorer-hooks && pnpm vitest run src/__tests__/use-file-system.test.ts`
Expected: PASS.

- [ ] **Step 2: Make the 3 mutators required in `UseFileSystemParams`** (`use-file-system.ts:10-48`): change `addActiveRoot?`, `removeActiveRoot?`, `setActiveRoots?` to non-optional (remove the `?`). Update the `MultiRootRestoreParams.setActiveRootsRef` type (`:218`) from `{ current: ... | undefined }` to `{ current: FileExplorerState['setActiveRoots'] }`.

- [ ] **Step 3: Remove the silent guards, call directly:**
  - `:292` `if (typeof setActiveRootsCurrent === 'function') { ... }` → call `setActiveRootsCurrent(storedDescriptors)` directly (the ref is now always a function).
  - `:341` in `updateCurrentFolderId`: remove the `typeof setCurrentFolderId === 'function'` check + the `else` warn; call `setCurrentFolderId(folderId)` directly (it is already required-typed).
  - `:386` keep `if (persisted)` but drop `&& typeof addActiveRoot === 'function'` → `if (persisted) { addActiveRoot(...) }`.
  - `:397` `if (typeof addActiveRoot === 'function') { addActiveRoot(...) }` → call directly.
  - `:448` `if (typeof removeActiveRoot === 'function') { removeActiveRoot(rootId); }` → `removeActiveRoot(rootId);`.
  - `:534` `if (typeof addActiveRoot === 'function') { addActiveRoot({...}) }` → call directly.
  - **DO NOT touch** `:352/353` (`showDirectoryPicker`/`requestDirectoryAccess`), `:513/646` (`restoreRoots`), `:105` (`removeRoot`) — these are legitimate platform/adapter capability checks.

- [ ] **Step 4: Run hooks tests + type-check**

Run: `cd packages/file-explorer-hooks && pnpm test && pnpm type-check`
Expected: PASS. The required-prop change will surface compile errors at any call site that omits a mutator — there is one real call site (`use-file-system-context.ts`, which already passes all three at `:217-219`), so it should compile. Fix any test fixtures that omitted them.

- [ ] **Step 5: Commit**

```bash
git add packages/file-explorer-hooks/src/use-file-system.ts packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts
git commit -m "refactor(file-explorer): require store-sync callbacks (no silent no-ops)

addActiveRoot/removeActiveRoot/setActiveRoots are now required deps; the
typeof===function guards that silently no-op'd (orphaning a store descriptor =
ghost root on reboot) are removed. Legitimate platform/adapter capability checks
(showDirectoryPicker, restoreRoots, removeRoot) are untouched."
```

### Task B3: Consolidate focus-shift (drop the redundant 2nd write)

**Files:**
- Modify: `packages/file-explorer-ui/src/shell/use-file-system-context.ts`

- [ ] **Step 1:** In `removeRootDirectory` (`use-file-system-context.ts:258-293`), the core hook (`coreApi.removeRootDirectory`) already performs the snapshot→focus-shift→purge sequence internally (`use-file-system.ts:423-461`). The context wrapper's comment (`:278-283`) acknowledges its `setRootDirectoryHandle(nextFocused)` is "intentionally redundant." Since the store handle is being removed in B4/B5, the only remaining purpose of the context-level write vanishes. Keep `removeRootDirectory` delegating to `coreApi.removeRootDirectory(rootId)`; the store-handle write is dropped as part of B5. (No standalone code change here beyond what B5 does — this task is a checkpoint to confirm the focus-shift authority lives solely in the core hook. Verify by re-reading both functions.)

- [ ] **Step 2:** Run `cd packages/file-explorer-ui && pnpm test`. Expected: PASS (no change yet — folded into B5).

### Task B4: Fixture event-bridge (reroute non-React injection)

**Files:**
- Modify: `packages/file-explorer-ui/src/setup-inline-fixture-subscription.ts`
- Modify: `packages/file-explorer-ui/src/shell/use-file-system-context.ts`
- Create: `packages/file-explorer-ui/src/inject-root-handle-event.ts` (shared event-name + typed detail)

- [ ] **Step 1: Create the typed event module**

```ts
// packages/file-explorer-ui/src/inject-root-handle-event.ts
import type { DirectoryHandle } from '@brainstrike/file-system';

/**
 * Non-React → React bridge for injecting a root handle into the reducer.
 * Dispatched by the inline-fixture subscription (which runs outside React and
 * cannot dispatch into the React-only file-system reducer); consumed by
 * useFileSystemInstance. Mirrors the codebase's existing custom-event idiom
 * (brainstrike:file-explorer-refreshed, :queue-drained).
 */
export const INJECT_ROOT_HANDLE_EVENT = 'brainstrike:inject-root-handle' as const;

export interface InjectRootHandleDetail {
  handle: DirectoryHandle | null;
}

export function dispatchInjectRootHandle(handle: DirectoryHandle | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<InjectRootHandleDetail>(INJECT_ROOT_HANDLE_EVENT, { detail: { handle } })
  );
}
```

- [ ] **Step 2: Write a failing test** (`use-file-system-context.test.ts`) asserting that dispatching `INJECT_ROOT_HANDLE_EVENT` with a handle results in the context's `rootDirectoryHandle` reflecting it (via the reducer), and `{handle:null}` clears it.

Run: `cd packages/file-explorer-ui && pnpm vitest run src/__tests__/use-file-system-context.test.ts`
Expected: FAIL (listener not wired yet).

- [ ] **Step 3: Add the listener in `useFileSystemInstance`** (`use-file-system-context.ts`), after `setRootHandle`/`clearRootDirectory` are defined:

```ts
// Non-React fixture injection bridge: the inline-fixture subscription runs
// outside React and dispatches brainstrike:inject-root-handle; route it through
// the same reducer path a real "set root" uses.
useEffect(() => {
  const onInject = (event: Event): void => {
    const detail = (event as CustomEvent<InjectRootHandleDetail>).detail;
    if (detail?.handle) {
      setRootHandle(detail.handle);
    } else {
      clearRootDirectory();
    }
  };
  window.addEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
  return () => window.removeEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
}, [setRootHandle, clearRootDirectory]);
```

(Add `import { INJECT_ROOT_HANDLE_EVENT, type InjectRootHandleDetail } from '../inject-root-handle-event';`. Note: `setRootHandle` and `clearRootDirectory` are defined as plain consts in this hook; if their identity is unstable, wrap them in `useCallback` or read via refs to keep the effect from re-subscribing each render — confirm during implementation.)

- [ ] **Step 4: Switch the fixture subscription to dispatch the event** (`setup-inline-fixture-subscription.ts`):
  - `:82` `store.getState().setRootDirectoryHandle(handle);` → `dispatchInjectRootHandle(handle);`
  - `:88` `store.getState().setRootDirectoryHandle(null);` → `dispatchInjectRootHandle(null);`
  - `:74` early-return `store.getState().rootDirectoryHandle` → track the last injected handle in a closure variable (`let lastInjectedHandle: DirectoryHandle | null = null;` updated in `applyFixtureState`) and return that.
  - Add `import { dispatchInjectRootHandle } from './inject-root-handle-event';`.

- [ ] **Step 5: Run the ui tests**

Run: `cd packages/file-explorer-ui && pnpm test`
Expected: PASS (the injection now flows reducer-ward; the context return still falls back to `coreApi.rootDirectoryHandle`, and the store handle still exists at this step so nothing else breaks).

- [ ] **Step 6: Commit**

```bash
git add packages/file-explorer-ui/src/inject-root-handle-event.ts packages/file-explorer-ui/src/setup-inline-fixture-subscription.ts packages/file-explorer-ui/src/shell/use-file-system-context.ts packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts
git commit -m "refactor(file-explorer): route inline-fixture injection through a CustomEvent

The fixture subscription (non-React) now dispatches brainstrike:inject-root-handle
instead of writing the store handle directly; useFileSystemInstance listens and
injects through the reducer (the same path a real set-root uses). Preserves the
window.__BRAINSTRIKE_LOAD_FIXTURE__ E2E API; prerequisite for removing the store
handle cache."
```

### Task B5: Remove the store's `rootDirectoryHandle` cache (single render source)

**Files:**
- Modify: `packages/types/src/file-explorer-types.ts`
- Modify: `packages/file-explorer/src/store.ts`
- Modify: `packages/file-explorer-ui/src/shell/use-file-system-context.ts`

- [ ] **Step 1: Write/adjust the test** asserting the context's `rootDirectoryHandle` now derives solely from the reducer (`coreApi.rootDirectoryHandle`) — i.e., after a `selectRootDirectory`/`setRootHandle`, the returned handle matches the reducer's, with no store involvement. Run: expect FAIL only if it references the removed store field; otherwise it stays green and becomes the guard.

- [ ] **Step 2: Remove from `packages/types/src/file-explorer-types.ts`:** the `rootDirectoryHandle` field (`:394-395`, incl. the "Ephemeral handle..." comment) and the `setRootDirectoryHandle` method type (`:448`) from `FileExplorerState`.

- [ ] **Step 3: Remove from `packages/file-explorer/src/store.ts`:** the `rootDirectoryHandle: null` initial value (`:44`) and the `setRootDirectoryHandle` action (`:66-68`).

- [ ] **Step 4: Edit `packages/file-explorer-ui/src/shell/use-file-system-context.ts`:**
  - Delete the `storedRootDirectoryHandle` selector (`:118`) and the store-`setRootDirectoryHandle` selector (`:119`).
  - Delete the one-way `useLayoutEffect` sync (`:333-345`).
  - Remove the store-handle writes: `selectRootDirectory` (`:228`), `clearRootDirectory` (`:242`), `removeRootDirectory` (`:284`), `registerRestoredHandles` (`:306`), `setRootHandle` (`:321`). In `setRootHandle`, keep `coreApi.setRootDirectoryHandle(handle)` + the rehydrate; drop only the store write.
  - Return (`:414`): `rootDirectoryHandle: coreApi.rootDirectoryHandle` (drop `storedRootDirectoryHandle ??`). Remove `storedRootDirectoryHandle` from the memo deps (`:440`).
  - The exposed `setRootDirectoryHandle: setRootHandle` (`:421`) STAYS (it dispatches into the reducer).

- [ ] **Step 5: Type-check the three packages + run their tests**

Run: `cd packages/types && pnpm type-check && cd ../file-explorer && pnpm test && cd ../file-explorer-ui && pnpm test`
Expected: PASS. Any remaining `store.rootDirectoryHandle` / `store...setRootDirectoryHandle` reference becomes a compile error pointing at a missed consumer — fix it (e.g., `setup-inline-fixture-subscription.ts:74` already handled in B4; confirm no others via `git grep "\.rootDirectoryHandle" packages/file-explorer packages/file-explorer-ui | grep -v coreApi`).

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/file-explorer-types.ts packages/file-explorer/src/store.ts packages/file-explorer-ui/src/shell/use-file-system-context.ts packages/file-explorer-ui/src/__tests__/use-file-system-context.test.ts
git commit -m "refactor(file-explorer): reducer is the sole live-handle owner

Remove the store's duplicate rootDirectoryHandle cache + setRootDirectoryHandle
action; the context returns coreApi.rootDirectoryHandle directly (single render
source). Fixture injection now flows through the event bridge (B4), so the
non-React path is preserved. Also drops the redundant context-level focus-write."
```

---

## Phase C — Whole-repo verification

- [ ] **C1: Targeted suites green together**

Run: `cd packages/agent && pnpm test && cd ../assistant-contract && pnpm test && cd ../file-explorer-hooks && pnpm test && cd ../file-explorer && pnpm test && cd ../file-explorer-ui && pnpm test`
Expected: all PASS.

- [ ] **C2: Lint (biome errors only)**

Run (repo root): `pnpm exec biome check .` — read the `Found N errors` line (warnings do not fail CI).
Expected: 0 errors. If formatting differs, `pnpm exec biome check . --write` then re-commit.

- [ ] **C3: Full gate**

Run (repo root): `pnpm check`
Expected: build + types + lint + unit all green together. Iterate until clean in one run.

- [ ] **C4: E2E fixture smoke (the reroute's live proof)**

Run the web E2E smoke (or a targeted fixture test) that exercises `window.__BRAINSTRIKE_LOAD_FIXTURE__`. Confirm a fixture root still loads and renders. (This is the behavior the event-bridge reroute must preserve.)

---

## Self-Review

**1. Spec coverage:**
- Part 1 dedup → Task A1. ✓
- Part 2 #1 (store handle removal) → B5; fixture reroute → B4. ✓
- Part 2 #2 (required callbacks) → B2. ✓
- Part 2 #3 (focus-shift consolidation) → B3 (+ realized in B5). ✓
- Behavior-preserving discipline (characterization first) → B1. ✓
- E2E fixture verification → C4. ✓

**2. Placeholder scan:** No TBD/TODO. Steps that say "confirm during implementation" (B4 Step 3 callback stability; B5 Step 5 grep) are explicit verification actions with the exact command/criterion, not vague placeholders.

**3. Type consistency:** `INJECT_ROOT_HANDLE_EVENT`, `InjectRootHandleDetail`, `dispatchInjectRootHandle` are defined once (B4 Step 1) and used consistently (B4 Steps 3–4). `RuntimeData extends Omit<ContractRuntimeData,'providerOptions'|'memory'>` is consistent across A1 + the type test.

**4. Scope check:** Two coherent parts in one PR (per user decision). Part 1 can be reverted independently (separate commit) if needed.

**Ordering invariant:** B4 (fixture reroute) MUST land before B5 (store-handle removal) — removing the store handle before the event bridge is wired would break the E2E fixture path.

---

## Plan deltas from adversarial verification (5-lens workflow)

Confirmed sound: **Part 1** (the 7 supporting types ARE byte-identical; `extends Omit<ContractRuntimeData,'providerOptions'|'memory'>` type-checks; `provider` gains `'local'`). Apply these corrections during implementation:

**D1 — B4 Step 3 listener must be ref-based (BLOCKER).** `setRootHandle`/`clearRootDirectory` are recreated each render, so an effect depending on them re-subscribes every render. Use stable refs + an empty-dep effect that subscribes ONCE:
```ts
const setRootHandleRef = useRef(setRootHandle);
setRootHandleRef.current = setRootHandle;
const clearRootDirectoryRef = useRef(clearRootDirectory);
clearRootDirectoryRef.current = clearRootDirectory;
useEffect(() => {
  const onInject = (event: Event): void => {
    const detail = (event as CustomEvent<InjectRootHandleDetail>).detail;
    if (detail?.handle) { setRootHandleRef.current(detail.handle); }
    else { clearRootDirectoryRef.current(); }
  };
  window.addEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
  return () => window.removeEventListener(INJECT_ROOT_HANDLE_EVENT, onInject);
}, []);
```

**D2 — B5 missed store-handle consumers (MAJOR, outside file-explorer/ui).** Add to B5 Step 4:
- `packages/app-shell/src/threads-panel.tsx:954` — reads `store.rootDirectoryHandle`; repoint to the context handle (`useFileSystem().rootDirectoryHandle`) or the relevant reducer-sourced value.
- `packages/file-explorer-ui/src/shell/use-file-explorer-context.ts:118` (selector) and `:479` (read inside the stale-state-clearing timeout) — repoint to `coreApi.rootDirectoryHandle` / the context's reducer handle (they're in lockstep, so the guard result is unchanged).

**D3 — B5 Step 5 verification must include app-shell.** Add `cd packages/app-shell && pnpm type-check` (and re-confirm file-explorer-ui) so the missed consumers surface as compile errors. Also `git grep -n "rootDirectoryHandle" packages apps | grep -v "coreApi\." | grep -v "\.claude/"` and confirm every remaining hit is the reducer/context handle, not the removed store field.

**D4 — Test-fixture updates (MAJOR), make them explicit tasks:**
- B2: `use-file-system.test.ts` — the ~20 single-root cases (≈ lines 42–730) pass only `setCurrentFolderId`. Add stub `addActiveRoot`/`removeActiveRoot`/`setActiveRoots` (a shared `makeParams(overrides)` helper is cleanest). The multi-root cases (≈ 757+) already pass all three.
- B4/B5: `setup-inline-fixture-subscription.test.ts` — currently mocks `store.setRootDirectoryHandle` / reads `store.rootDirectoryHandle`; update to assert a `brainstrike:inject-root-handle` dispatch (and drop store-handle assertions).
- B5: `use-file-system-context.test.ts:499` — asserts `store.getState().rootDirectoryHandle`; change to assert the context's `rootDirectoryHandle` (reducer-sourced).

**D5 — B4 intermediate state is benign (clarification).** Between B4 and B5 the listener writes the store handle (via `setRootHandle`) AND the one-way `useLayoutEffect` (`:333`) still exists; both end with the store written (the `!storedRootDirectoryHandle && coreApi.rootDirectoryHandle` guard just skips when the listener already wrote). No partial-load. B5 then removes the layout effect's store sync entirely (keep only its `isAccessLoading` sync — verify that effect, `:352`, is separate and untouched).

**D6 — minors/nits:** the 3 of 7 unified types not previously in `agent/index.ts` (`RuntimeAgentLoopSettings`, `RuntimeWorkspaceIndexStatusState`, `RuntimeWorkspaceIndexQueueProgress`) become harmless new public re-exports — `git grep` to confirm no agent-internal name reference breaks. Verify the exact `file-explorer-types.ts` field line (`:395` field vs `:394` comment) at edit time. Document at `setup-inline-fixture-subscription.ts:73-74` that the synchronous return is "last dispatched intent" (E2E awaits the Promise). `use-inline-fixture-effect.ts` confirmed dead — Phase C grep-asserts no active mount; cleanup deferred.
