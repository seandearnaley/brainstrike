# Dual-State Refactor — Design Spec (2026-06-13)

> **Status:** Approved design, pre-implementation.
> **Source:** Multi-root follow-up §8b ("architecture refactors") from
> `docs/multi-root-handoff-2026-06-13.md`.
> **Scope decision:** "Both, the safe way" — RuntimeData dedup + a
> *behavior-preserving* reframing of the dual root-handle-state work.

---

## 0. Summary

Two unrelated "dual state" smells accreted during the multi-root work. This spec
covers both, behavior-preserving, landed behind tests:

- **Part 1 — `RuntimeData` dedup.** Two parallel `RuntimeData` type clusters
  exist (`packages/agent/src/types.ts` and
  `packages/assistant-contract/src/runtime-data.ts`) with a documented
  "keep in sync" obligation that has already drifted. Unify the *identical*
  supporting types in the dependency-light contract package and make agent's
  `RuntimeData` **extend** it, overriding only the few fields that are
  deliberately library-bound.
- **Part 2 — root-handle state: single-owner-per-concern + harden the sync seam.**
  The original follow-up framing ("collapse the dual root-handle state to one
  source of truth") is **not behavior-preserving** and is partly impossible
  (see §3.1). Instead: make the reducer the sole owner of live handles, make the
  reducer→store sync dependencies required (no silent no-ops), and consolidate
  the focus-shift ordering.

---

## 1. Goals / Non-goals

**Goals**
- Remove the `RuntimeData` "keep the two declarations in sync" drift hazard.
- Close the latent `provider` `'local'` gap in agent's `RuntimeData`.
- Make the root-handle live object live in exactly one place.
- Eliminate the silent-no-op store-sync callbacks (a no-silent-fallbacks
  violation that produces the "ghost root" bug class).
- Preserve all observable behavior; land everything behind tests.

**Non-goals**
- Do **not** move agent's library-bound types (`RuntimeProviderOptions`,
  `RuntimeMemoryContext`) into `assistant-contract` (would force Mastra/AI-SDK
  deps into the dependency-light contract package — see §2.1).
- Do **not** attempt the "big" collapse (move live handles into the store's
  in-memory slice + delete the reducer). That is a large, higher-risk structural
  change, explicitly out of scope here (recorded as a possible future pass).
- No unrelated refactoring of nearby code.

---

## 2. Part 1 — `RuntimeData` dedup

### 2.1 Why the two exist (verified)

Package dependencies (verified from `package.json`):
- `@brainstrike/assistant-contract` deps = **`@brainstrike/utils` only** (no
  Mastra, no AI-SDK). It is the **dependency-light wire/UI contract**, importable
  by app-shell / UI without pulling in runtime libraries.
- `@brainstrike/agent` deps on `assistant-contract` (`workspace:*`) **plus**
  `@mastra/core` and `@ai-sdk/provider`.

So the divergence is **intentional and load-bearing**, not accidental drift:
agent binds several fields to the real runtime libraries; contract keeps a
dependency-free mirror. Dependency direction is one-way (`agent → contract`), so
agent may `extends` / import contract, never the reverse.

### 2.2 Field/type inventory (verified)

**Identical supporting types** (byte-for-byte same shape in both files →
unify, canonical in contract):
- `RuntimeAgentLoopSettings`
- `RuntimeModelSettings`
- `RuntimeWorkspaceContextMetadata` (+ `RuntimeWorkspaceContextFileMetadata`,
  `RuntimeWorkspaceContextRangeMetadata`)
- `RuntimeWorkspaceIndexStatusState`
- `RuntimeWorkspaceIndexQueueProgress`

**Deliberately divergent types** (agent binds to AI-SDK / Mastra → stay in
agent, documented):
- `RuntimeProviderOptions` (+ `OpenAiProviderOptions`,
  `AnthropicProviderOptions`, `GoogleProviderOptions`, `LocalProviderOptions`,
  `LocalRuntimeProviderOptions`): contract bases on `RuntimeJsonObject`; agent
  bases on `(SharedV2ProviderOptions | SharedV3ProviderOptions)` + `JSONObject`.
- `RuntimeMemoryContext`: contract's `memoryOptions?: RuntimeMemoryOptions`
  (plain record); agent's `memoryOptions?: AgentMemoryOption['options']`
  (`@mastra/core`).

**`provider` union divergence (a latent bug):** contract includes `'local'`;
agent omits it — yet desktop checks `provider === 'local'`. Resolved by agent
*inheriting* `provider` from contract.

**Agent-only fields** (server-side, never serialized): `localLlmHostClient`,
`mastraTools`, `mcpConfig`.

### 2.3 Target shape

`assistant-contract` remains the canonical owner of the dependency-free types.
`agent/src/types.ts`:

```ts
import type {
  RuntimeData as ContractRuntimeData,
  // re-exported identical supporting types:
  RuntimeAgentLoopSettings,
  RuntimeModelSettings,
  RuntimeWorkspaceContextMetadata,
  RuntimeWorkspaceIndexQueueProgress,
  RuntimeWorkspaceIndexStatusState,
} from '@brainstrike/assistant-contract';

// agent KEEPS its library-bound versions (documented why):
//   RuntimeProviderOptions  (AI-SDK based)
//   RuntimeMemoryContext    (Mastra based)

export interface RuntimeData extends Omit<ContractRuntimeData, 'providerOptions' | 'memory'> {
  /** AI-SDK-bound provider options (agent runtime; not serialized as-is). */
  providerOptions?: RuntimeProviderOptions;
  /** Mastra-bound memory context. */
  memory?: RuntimeMemoryContext;
  // server-only, never serialized over IPC/HTTP:
  localLlmHostClient?: LocalLlmHostClient;
  mastraTools?: ToolsInput;
  mcpConfig?: McpConfig;
}
```

Outcomes:
- `provider` is inherited → agent gains `'local'`, closing the gap.
- The 28 shared fields (of contract's 30; only `providerOptions` + `memory` are
  overridden) + 7 supporting types stop being duplicated.
- The "keep the two declarations in sync" comment is deleted.
- Agent's `index.ts` re-exports the now-contract-owned supporting types so
  agent's public API surface (consumed by desktop/web) is unchanged.

### 2.4 Risk & gate
**Moderate-low.** The `Omit` + override must remain assignable for every agent
construction/consumption site, and downstream importers of the re-exported
supporting types must still type-check. Gate = `build` + `type-check` across
`agent`, `assistant-contract`, `app-shell`, `desktop`, `web`. Add a type-level
assignability assertion (agent `RuntimeData` is assignable to
`ContractRuntimeData` for the shared fields) so future drift fails compilation.

---

## 3. Part 2 — root-handle state: single-owner-per-concern + harden the sync seam

### 3.1 Why "one source of truth" is the wrong literal target (verified)

The two locations are a **dependency pair**, not redundancy:
- **Reducer** (`packages/file-explorer-hooks/src/use-file-system.ts`,
  `FileSystemState`) holds the **live `DirectoryHandle` objects**
  (`rootDirectoryHandles: DirectoryHandle[]`, focused `rootDirectoryHandle`,
  `rootIdByPath`). Non-serializable; unreconstructable without re-prompting.
- **Store** (`packages/file-explorer/src/store.ts`, types in
  `packages/types/src/file-explorer-types.ts`) holds **persisted descriptors**
  (`activeRootIds`, `rootDescriptors: Record<rootId, StoredRootDescriptor>`
  where `StoredRootDescriptor = {rootId, path, displayName}`) plus per-root
  `folderStates`. These survive reload; the adapter uses them on boot to decide
  which handles to re-request.

A single *persisted* source cannot hold a *live* handle — different lifetimes.
True collapse is only possible by holding live handles in the store's
non-persisted in-memory slice and deleting the reducer — large/risky, out of
scope (§1 non-goals). So we target the achievable, behavior-preserving wins.

### 3.2 Change 1 — reducer is the sole live-handle owner

The store *also* caches a focused `rootDirectoryHandle`
(`file-explorer-types.ts:395`, `store.ts:44/66-67`) — the one genuinely
duplicated handle, synced one-way from the reducer. The reducer **already**
tracks the focused handle (`FileSystemState.rootDirectoryHandle`), so the store's
copy is pure duplication. Remove the store's cached handle (and its
`setRootDirectoryHandle` setter + the one-way sync that writes it); consumers
that need the focused handle read it from the reducer via the `FileSystemProvider`
context. After this, the live handle exists in exactly one place (the reducer).

Plan-phase task: enumerate every reader of `store.rootDirectoryHandle` /
`setRootDirectoryHandle` and repoint them to the reducer's focused handle (some
may be non-React/selector reads that need a different accessor than the context
hook — flag those in the plan).

### 3.3 Change 2 — required sync dependencies (no silent no-ops)

`use-file-system.ts` guards its store-sync callbacks with silent
`typeof x === 'function'` no-ops. A missing `removeActiveRoot` silently orphans a
store descriptor → "ghost root" on next boot. This violates the project's
no-silent-fallbacks rule.

**Make these store-sync dependencies required** (passed by the single
`FileSystemProvider`); absence throws at wiring time rather than no-opping at
runtime. Targets (verified line numbers, the *store-sync* guards only):
- `:292` `setActiveRootsCurrent`
- `:341` `setCurrentFolderId`
- `:386` `addActiveRoot` (persisted mid-session add)
- `:397` `addActiveRoot`
- `:448` `removeActiveRoot`
- `:534` `addActiveRoot` (restore path)

**Explicitly NOT touched — legitimate capability detection (must stay):**
- `:352` `globalThis.showDirectoryPicker`
- `:353` `fileSystemAdapter.requestDirectoryAccess`
- `:513`, `:646` `adapter.restoreRoots`

These probe genuinely-optional platform/adapter features. (If anything, a missing
feature should be surfaced loudly, but that is not in scope here — leave the
checks as-is.)

> **Discriminator:** required *dependency* that's always wired → make required &
> throw. Genuinely-optional *platform capability* → keep the runtime check.

### 3.4 Change 3 — one focus-shift orchestration point

The strict disconnect ordering (snapshot outgoing folder via `setCurrentFolderId`
→ remove handle from reducer → purge store descriptor via `removeActiveRoot`) is
currently split across the context wrapper
(`packages/file-explorer-ui/src/shell/use-file-system-context.ts`) and the core
hook. Consolidate it into one orchestration point so the ordering invariant lives
in a single place and can't be reordered by a future caller.

### 3.5 Risk & gate
**Moderate.** Touches the reducer, the store, the context wrapper, and their
tests. Behavior-preserving → write characterization tests for add / restore /
remove / focus-shift **before** refactoring (see §4). Gate = full
`build + types + lint + unit` green together.

---

## 4. Sequencing & testing strategy

1. **Part 1 first** — isolated to `agent` / `assistant-contract` types, lowest
   behavioral risk. Can land as its own PR if desired.
2. **Part 2 second** — write characterization tests first, then refactor change
   by change (3.2 → 3.3 → 3.4), keeping the suite green at each step.

Testing:
- **Part 1:** type-check + existing field-access tests
  (`packages/agent/src/__tests__/*`,
  `apps/desktop/src/__tests__/assistant-server/*`) + a new type-level
  assignability assertion.
- **Part 2:** characterization tests in
  `packages/file-explorer-hooks/src/__tests__/use-file-system.test.ts` and the
  store/context tests pin current add/restore/remove/focus-shift behavior before
  any change; new tests assert the required-dependency throw paths and the
  reducer-derived focused handle.

Process:
- Branch from a **freshly-pulled `main`** (PR #1199 / a parallel session may have
  landed). Never commit to `main` directly.
- Full gate before declaring done: build + types + lint + unit all green in the
  same run.

---

## 5. Invariants preserved
- No silent fallbacks (this work *removes* some; it must not add any).
- `assistant-contract` stays dependency-light (no Mastra / AI-SDK).
- Multi-root identity model unchanged (adapter `RootId` keys UI/store; DB ids via
  reconcile map; `handle.path` is fallback). This refactor touches neither
  reconciliation nor DB id resolution.
- The reducer↔store dependency pair is preserved (we are *not* collapsing it,
  only de-duplicating the handle cache and hardening the seam).

---

## 6. Open questions for the plan phase
- Exact consumer list of `store.rootDirectoryHandle` (for §3.2 repoint).
- Whether `setCurrentFolderId` (`:341`) is always wired or has a legitimate
  no-provider path (it may be optional during early boot); confirm before making
  it required.
- Where the single focus-shift orchestration point should live (core hook vs
  context wrapper) given the provider is now the single mount point.

---

## 7. Key file map
| Area | File |
| --- | --- |
| Contract RuntimeData (canonical base) | `packages/assistant-contract/src/runtime-data.ts` |
| Agent RuntimeData (extends + overrides) | `packages/agent/src/types.ts`, `packages/agent/src/index.ts` |
| Reducer / live handles | `packages/file-explorer-hooks/src/use-file-system.ts` |
| Store / descriptors + cached handle | `packages/file-explorer/src/store.ts`, `packages/types/src/file-explorer-types.ts` |
| Store root actions | `packages/file-explorer/src/actions/active-root-actions.ts` |
| Context wrapper / sync seam | `packages/file-explorer-ui/src/shell/use-file-system-context.ts` |
| FileSystemProvider (single mount) | `packages/file-explorer-ui/src/shell/file-system-provider.tsx` |

---

*Design approved 2026-06-13. Next step: implementation plan via writing-plans.*
