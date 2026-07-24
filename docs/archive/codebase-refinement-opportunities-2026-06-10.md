# Brainstrike Codebase Refinement Opportunities

Date: 2026-06-10

Scope: current checkout at `/Users/seandearnaley/.codex/worktrees/9253/brainstrike`. The local `main` worktree is one commit behind `origin/main`; this report does not change branch state or include that remote commit.

## Method

This pass prioritized high-impact opportunities that reduce operational risk, improve single responsibility, remove drift-prone manual processes, or make hot code paths easier to reason about. I read package ownership docs, source entrypoints, tests, and architecture notes before ranking. I did not treat file size alone as a bug; large files are flagged only when they concentrate multiple responsibilities or hide failure modes.

Ranking criteria:

1. User-visible risk or failure blast radius.
2. Fit with existing architecture contracts in `AGENTS.md`.
3. Ability to implement as red/green TDD stacks.
4. Long-term leverage: removing repeated manual work or fragile patterns.
5. Probability of finding defects while refactoring.

## Recommended Sequence

1. Harden the assistant runtime with real Mastra tool-loop coverage before wiring existing resilience utilities.
2. Finish TreeTable convergence for the context preview table.
3. Split `AssistantUiPanelWrapper` into small composition hooks and request-lifecycle services.
4. Decompose the local runtime adapter into pure planning, tool-schema, and transport modules.
5. Automate model catalog migrations and preference remaps.
6. Unify DB unit and coverage lane registries.
7. Introduce strict shared environment parsing and migrate silent/partial parsers.
8. Make persistence fallback and factory reset outcomes explicit.
9. Extract token-indexing dispatch planning from large React integration hooks.
10. Split the desktop embedding E2E shared fixture into scenario builders and assertions.

This is also the stack order I would use. The first four address live assistant/tree UX complexity; the next three remove recurring correctness traps; the last three improve maintainability and test ergonomics without changing product behavior.

## Ranked Opportunities

| Rank | Opportunity | Primary Benefit | Suggested Stack Size |
| --- | --- | --- | --- |
| 1 | Assistant runtime resilience with real Mastra coverage | Prevents frozen assistant threads without breaking hosted tool execution | 2-3 PRs |
| 2 | Context preview table TreeTable convergence | Removes duplicate table/treegrid behavior and aligns accessibility/performance | 2 PRs |
| 3 | App-shell assistant wrapper decomposition | Restores thin app-shell boundary and reduces regression surface | 3-4 PRs |
| 4 | Local runtime adapter decomposition | Separates state machine, schema normalization, and host/browser transport | 2-3 PRs |
| 5 | Model catalog migration automation | Prevents static registry, DB catalog, and preference remap drift | 2 PRs |
| 6 | DB lane registry unification | Removes a known CI/nightly coverage footgun | 1 PR |
| 7 | Strict shared env parsing | Enforces no silent fallback on runtime config | 2 PRs |
| 8 | Explicit storage/reset failure contracts | Makes degraded persistence and incomplete reset observable | 2-3 PRs |
| 9 | Token-indexing dispatch planner extraction | Moves timing-heavy indexing decisions out of React hooks | 2 PRs |
| 10 | Desktop embedding E2E fixture split | Makes critical renderer-host tests cheaper and safer to modify | 1-2 PRs |

## 1. Assistant Runtime Resilience Needs Real Mastra Coverage First

Precedence: highest. This is live user-facing behavior, and the architecture doc explicitly warns that prior wiring of guard/watchdog utilities broke real Mastra tool execution while mocked tests stayed green.

Evidence:

- `packages/agent/src/tools/guard-tool-execution.ts` already contains `applyToolGuards`, `GuardedToolError`, and timeout/error handling utilities.
- `packages/agent/src/stream/with-inactivity-timeout.ts` already contains `withInactivityTimeout` and `StreamStalledError`.
- `packages/agent/src/config/resilience-config.ts` already has strict timeout parsing and the invariant that tool timeout must be below stream inactivity.
- `packages/agent/src/mastra/mcp-tool-loader.ts` currently wraps MCP tool outputs but does not call `applyToolGuards`.
- `packages/agent/src/mastra/agent-runtime.ts` currently iterates the raw Mastra stream in `streamChunksFromMastra`.
- `packages/agent/src/__tests__/mastra-tool-execution.spec.ts` is a good new foundation because it exercises the real Mastra agent loop and real tool `execute`.
- `packages/agent/src/__tests__/mastra-streaming.spec.ts` still broadly mocks `@mastra/core/agent`, so it cannot prove real hosted tool execution survives wrapper changes.

Why it matters:

The current state has a known resilience gap and known test blind spot. Wiring the existing utilities without expanding real Mastra coverage would violate the project warning and risk silently disabling hosted-provider tool execution again.

Target shape:

- Keep the renderer safety net as the live backstop.
- Add real Mastra-loop tests for a hanging tool, a throwing tool, a stalled stream, and a healthy hosted-style tool call.
- Wire `applyToolGuards` only after the real tests fail for the intended reason.
- Wrap the raw stream with `withInactivityTimeout` only after a stalled-stream test proves the freeze.
- Preserve strict config parsing from `resilience-config.ts`.

Red/green stack:

1. PR 1: add failing real Mastra-loop tests that show a hanging tool and stalled stream freeze the run.
2. PR 2: wire `applyToolGuards` and `withInactivityTimeout` in the narrowest production paths.
3. PR 3: run live desktop/provider validation, then document exactly what is now live in `AGENTS.md`.

Stop conditions:

- Do not wire these utilities based only on mocked stream-part tests.
- Do not convert tool timeouts into invisible success. The UI needs structured failure output.

## 2. Finish TreeTable Convergence For Context Preview

Precedence: high. The repo already has a canonical treegrid implementation and an explicit convergence contract, while the context preview still has a legacy path.

Evidence:

- `packages/ui/src/tree-table/tree-table.tsx` documents the shared TreeTable primitive: virtualized hierarchical rows, selection, keyboard traversal, sorting, and WAI-ARIA treegrid semantics.
- `packages/file-explorer-ui/src/preview/preview-table.tsx` already uses TreeTable for grouped preview rows.
- The same file still keeps a hand-rolled ungrouped `<table>` path and has a TODO to converge that path onto TreeTable.
- `packages/ui/src/collection-browser/use-collection-tree.ts` remains a large tree transformation hook, so every duplicate tree/table path increases the cost of preserving UX parity.

Why it matters:

Tree behavior is a high-friction part of this app: selection, keyboard navigation, row identity, grouped slicing, search, and windowing all need to agree across the file explorer, context explorer, and collection browser. A second table implementation is an avoidable divergence point.

Target shape:

- Use TreeTable for both grouped and ungrouped context preview modes.
- Keep the existing ungrouped visuals and row actions as behavior-preserving adapters.
- Push preview-specific row rendering into column/cell adapters instead of bypassing TreeTable.
- Preserve `rowsReady`, selection correctness, sort behavior, and persistent column sizing.

Red/green stack:

1. Add characterization tests for the current ungrouped preview table: row count, keyboard focus, selection, sort headers, empty state, and column sizing.
2. Port the ungrouped path onto TreeTable with no product changes.
3. Add shared UI tests only for behavior that belongs in TreeTable; keep preview-specific tests in `file-explorer-ui`.

Stop conditions:

- Do not tune virtualization strategy while doing this stack unless a test proves it is required.
- Do not change grouped preview behavior in the same PR as the ungrouped conversion.

## 3. Split `AssistantUiPanelWrapper` Into Composition Hooks And Services

Precedence: high. `packages/app-shell/AGENTS.md` says app-shell should stay thin, but the current assistant wrapper owns multiple state machines.

Evidence:

- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` imports assistant contract types, DB hooks, file explorer helpers, preference stores, UI components, runtime adapters, and background indexing state.
- The component is explicitly marked with a cognitive-complexity ignore because it coordinates stores, runtime probes, and transport paths.
- The file handles provider/model selection, assistant availability, thread/memory request preparation, foreground activity leases, MCP server menu state, and local/remote runtime routing.

Why it matters:

This wrapper is too central for its current responsibility count. It is difficult to reason about state ownership, and small changes to request lifecycle or preferences can accidentally affect rendering, foreground indexing leases, or MCP affordances.

Target shape:

- Keep the exported wrapper as the composition root.
- Extract pure or near-pure hooks with one owner each:
  - `useAssistantProviderSelection`
  - `useAssistantThreadRequestData`
  - `useAssistantForegroundLease`
  - `useAssistantMcpMenuState`
  - `useAssistantRuntimeAdapterSelection`
- Move request preparation and lease release into a small service with explicit acquire/complete/error semantics.

Red/green stack:

1. Add characterization tests around request-data creation, lease release, and runtime adapter selection.
2. Extract one hook at a time with no behavior changes.
3. After extraction, remove the component-level cognitive-complexity ignore only when the metric genuinely drops.

Stop conditions:

- Do not move domain logic into `packages/ui`; `ui` should remain presentational and reusable.
- Do not merge hook extraction with behavior changes to provider selection or memory threading.

## 4. Decompose The Local Runtime Adapter State Machine

Precedence: high. Local LLM execution is architecture-critical, renderer-only, and already split between visible UI and hidden host. The adapter should not remain a large mixed-responsibility module.

Evidence:

- `packages/ui/src/assistant-ui-panel/local-runtime-adapter.ts` contains schema normalization, tool definition building, event accumulation, generation setup, stream handling, background indexing pause, concurrency slot handling, and error conversion.
- The generator path has a cognitive-complexity ignore because it handles initialization, conversion, streaming, and errors in one function.
- A comment still describes browser inference as using WebGPU or WASM acceleration; current architecture forbids silent WASM fallback and requires desktop built-in local LLM work to run through the hidden `llm-host` renderer.

Why it matters:

This module sits at the boundary between UI, local model runtime, host transport, tool calls, and visible message output. When a bug appears here, it is hard to tell whether the issue is schema conversion, transport, generation lifecycle, or event rendering.

Target shape:

- Keep `local-runtime-adapter.ts` as a small adapter factory.
- Extract pure modules:
  - local tool schema normalization
  - message conversion
  - generation event reducer
  - host/browser transport selection
  - visible output sanitization
- Update comments so they match the no-WASM-fallback and hidden-host architecture.

Red/green stack:

1. Add pure unit tests for schema normalization, tool definitions, message conversion, and event reduction.
2. Extract pure modules first.
3. Extract transport selection after pure behavior is covered.
4. Keep desktop hidden-host behavior unchanged unless a test explicitly covers the change.

Stop conditions:

- Do not introduce a Node/main-process local LLM path.
- Do not hide WebGPU unavailability behind a fallback. Built-in local provider should be unavailable when required runtime surfaces are missing.

## 5. Automate Model Catalog Migration Safety

Precedence: medium-high. The codebase already documents that model catalog changes are multi-layer; the implementation still relies on humans remembering every file.

Evidence:

- `packages/assistant-contract/src/provider-registry.ts` is the static provider/model source.
- `packages/db/src/migrations/index.ts` manually registers numbered migrations.
- `packages/db/src/drizzle/migrate.ts` separately registers custom migrations for the real app.
- `packages/preferences/src/stores/assistant-preferences-store.ts` owns persisted assistant model ID remaps.
- `packages/preferences/src/stores/assistant-memory-preferences-store.ts` owns memory model target remaps.
- `packages/db/src/migrations/033-update-provider-models-2026-frontier.ts` shows the correct pattern for preserving `models.is_enabled`.

Why it matters:

Changing models is easy to get half-right. Tests can pass while existing users never receive catalog rows, or users can have preference selections dangling after a model removal.

Target shape:

- Add a model catalog change tool or verifier that compares static registry, DB catalog migrations, custom migration ledger, and preference remaps.
- Generate or validate migration stubs that preserve user toggles by default.
- Add a CI check that fails when static registry IDs change without an accompanying migration/remap decision.

Red/green stack:

1. Add a failing fixture test that changes a model ID without a migration/remap and proves the verifier catches it.
2. Implement the verifier using structured parsing where possible.
3. Add a migration-generation helper only after the verifier is stable.

Stop conditions:

- Do not trust model names or availability from memory. Calendar-sensitive model catalog work must verify upstream provider docs before implementation.
- Do not auto-force `is_enabled = EXCLUDED.is_enabled` for catalog refreshes.

## 6. Unify DB Unit And Coverage Lane Registries

Precedence: medium-high. This is a small stack with clear payoff because the repo already has two independent lane registries.

Evidence:

- `packages/db/scripts/test-lanes.mjs` assigns DB tests to unit lanes by regex.
- `packages/db/scripts/coverage-lanes.mjs` separately assigns DB tests to coverage lanes by explicit arrays.
- The static GitHub Actions job runs checks for both lane registries.
- `AGENTS.md` calls out that adding a DB test to one registry but not the other has historically broken Nightly Coverage.

Why it matters:

Two registries for the same test inventory guarantee drift. The current checks detect drift only after a contributor remembers to run them or CI spends a cycle.

Target shape:

- One declarative manifest for DB test lane metadata.
- `test-lanes.mjs` and `coverage-lanes.mjs` become consumers of the same manifest.
- Coverage lanes should default from unit lane ownership unless an explicit coverage override is declared.

Red/green stack:

1. Add tests for the current scripts that prove a synthetic new test must be present in both places.
2. Introduce a shared manifest and migrate both scripts.
3. Keep both command names and output contracts stable for CI.

Stop conditions:

- Do not change actual test grouping or CI concurrency in the same PR.
- Do not weaken the missing-test checks.

## 7. Introduce Strict Shared Runtime Configuration Parsing

Precedence: medium. The repo has some strict parsers, but several runtime config paths still rely on loose number coercion.

Evidence:

- `packages/agent/src/config/resilience-config.ts` strictly parses timeout values and throws malformed config.
- `apps/desktop/src/renderer/components/embedding-worker-config.ts` has local positive-integer parsing for Vite env.
- `packages/embeddings/src/worker/embedding-worker-scheduler.ts` has another local positive-integer option parser.
- `packages/embeddings/src/worker/embedding-worker.ts` parses values like `EMBED_REINIT_EVERY` and worker metrics interval with direct `Number(...)` style coercion.
- `packages/server-config/src/server.ts` parses `PORT` and `DESKTOP_PORT` with `Number.parseInt` and does not clearly reject malformed values.

Why it matters:

Malformed runtime configuration should fail loudly. Silent coercion, `NaN`, or defaulting can create the exact kind of hidden degradation the project rules forbid.

Target shape:

- Add a small shared config parser package or module for positive integers, bounded integers, booleans, finite numbers, enums, and optional values with explicit defaults.
- Migrate the loose config paths first.
- Keep all parse failures descriptive and actionable.

Red/green stack:

1. Add tests for malformed env values in `server-config` and embedding worker config that currently pass through or silently default.
2. Implement shared strict parsers.
3. Replace local parsers only when covered by tests.

Stop conditions:

- Do not make broad config shape changes in the same stack.
- Do not silently clamp invalid values unless the caller explicitly asks for bounded clamping and tests cover it.

## 8. Make Persistence Fallback And Factory Reset Outcomes Explicit

Precedence: medium. Storage degradation and reset incompleteness need to be visible because this is a local-first app.

Evidence:

- `packages/storage/src/safe-json-state-storage.ts` and `packages/utils/src/safe-storage.ts` fall back to memory-backed storage when browser storage is unavailable or writes fail.
- `packages/preferences/src/stores/browser-json-storage.ts` and `packages/preferences/src/stores/token-preferences-store.ts` catch localStorage failures and fall through to in-memory state.
- `packages/preferences/src/settings/system/factory-reset-helpers.ts` aims for a true reset, but IndexedDB and OPFS cleanup paths resolve or continue after some failures while CacheStorage cleanup is stricter.
- `AGENTS.md` says "Factory Reset Brainstrike" means a true fresh start and that wiping the DB alone is not enough.

Why it matters:

In a local-first product, persistence is not a convenience detail. A silent memory fallback can make preferences or tokens appear to work only for the current session. A partial factory reset can leave embeddings, providers, caches, or stale state behind.

Target shape:

- Distinguish test/SSR fallback from product runtime degradation.
- Return a structured `StorageHealth` or `PersistenceMode` status that UI and logs can surface.
- Make factory reset return or throw a structured `ResetResult` that lists every failed cleanup target.
- Keep best-effort cleanup where appropriate, but do not report success unless all required targets are cleared.

Red/green stack:

1. Add tests proving localStorage write failure is surfaced to product callers.
2. Add reset tests where IndexedDB or OPFS deletion fails and the reset result is incomplete.
3. Introduce structured health/result types and wire the existing call sites.

Stop conditions:

- Do not remove memory fallback from test or SSR contexts without first mapping current callers.
- Do not reload the renderer after a reset that is known to be incomplete unless the UI can show the failure.

## 9. Extract Token-Indexing Dispatch Planning From React Hooks

Precedence: medium-low. This should follow the assistant and table stacks because it is likely to touch timing-sensitive background work.

Evidence:

- `packages/token-cache/src/use-background-token-indexer.ts` owns worker lifecycle, file reading, hash detection, cache operations, progress, retry/restart budgets, and diagnostics.
- `packages/file-explorer-ui/src/indexing/use-background-token-indexer-integration.ts` bridges file tree state, selection, priority dispatch, shrink reconciliation, and background indexer lifecycle.
- The integration file documents selection priority and fallback queue behavior, which are policy decisions that deserve direct tests outside React render timing.

Why it matters:

Indexing behavior depends on ordering, cancellation, prioritization, and avoiding unnecessary work. Those rules are easier to test and optimize as pure planning functions than as side effects inside large hooks.

Target shape:

- Extract a pure dispatch planner for:
  - visible/selected file prioritization
  - shrink reconciliation
  - max-file and max-byte budget decisions
  - diagnostics for skipped or delayed work
- Leave worker lifecycle and React subscriptions in the hooks.
- Make the planner deterministic and fully serializable.

Red/green stack:

1. Add planner characterization tests by copying current expected decisions from hook-level tests.
2. Extract the planner with no behavior change.
3. Rewire hooks to consume planner output.

Stop conditions:

- Do not change indexing priority semantics during extraction.
- Do not move worker lifecycle into the planner.

## 10. Split The Desktop Embedding E2E Shared Fixture

Precedence: medium-low. This is test infrastructure, but it protects critical renderer-host architecture and currently carries too much setup surface.

Evidence:

- `apps/desktop/e2e/embedding-worker-renderer.shared.ts` is over 3,000 lines and has file-wide complexity/naming ignores.
- The header says it preserves setup helpers from a former monolithic spec.
- It exports app launch helpers, host status shapes, filesystem fixtures, locator helpers, DB helpers, and assertion utilities from one fixture surface.
- The embedding architecture is critical: workers must run in the hidden renderer host, not Electron main.

Why it matters:

When fixture setup is this concentrated, test changes become hard to review. That raises the cost of adding the live validation required for assistant, embedding, and hidden-host changes.

Target shape:

- Split by responsibility:
  - `electron-app-fixture.ts`
  - `embedding-host-fixture.ts`
  - `filesystem-fixture.ts`
  - `database-fixture.ts`
  - `embedding-assertions.ts`
  - `log-assertions.ts`
- Keep public test helper names stable where possible.
- Remove file-wide ignores by moving browser-global or DB-shaped exceptions near the narrow code that needs them.

Red/green stack:

1. Add a smoke import test or TypeScript-only test that proves existing E2E specs can still import the helper surface.
2. Move one helper group at a time.
3. Run the desktop embedding smoke specs after every move.

Stop conditions:

- Do not change E2E behavior or selectors in the fixture split.
- Do not add remote debugging flags to default desktop E2E.

## First Stack To Start

Start with opportunity 1, but only as a test-first stack:

1. Extend `packages/agent/src/__tests__/mastra-tool-execution.spec.ts` with a real Mastra-loop hanging-tool case.
2. Add a real stream-stall case for `streamChunksFromMastra`.
3. Verify the tests fail for the right reason on current code.
4. Wire `applyToolGuards` and `withInactivityTimeout` in the narrowest paths.
5. Run package tests, then perform live desktop/provider validation before declaring the resilience layers active.

This is the highest-value first move because the utilities already exist, the architecture warning is explicit, and a frozen assistant thread is worse than duplicated code style.

## Files Intentionally Not Touched

- `docs/documentation-comment-issues-inventory.md`: pre-existing untracked file in this worktree.
- Source and test files under `apps/` and `packages/`: this task is an audit/report, not an implementation stack.
- Git branch state: the worktree is behind `origin/main` by one commit, but this report does not fast-forward or merge.

## Validation Performed

- Read current worktree status.
- Read package and root architecture guidance.
- Scanned repository file sizes and code-pattern hotspots.
- Inspected representative files for each ranked opportunity.
- No build, lint, type check, or unit test run was needed because this change only adds this report.
