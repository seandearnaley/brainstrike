# W5 — Worktree Map, Agent Worktree Tools & Shell-Output Correlation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "what is running where" on one screen and let the agent participate honestly. A desktop **Worktree Map** workspace app tab renders every repository the workspace knows, its primary checkout and every worktree beside it — managed, Claude Code, Codex, Cursor or plain scanned — each card carrying branch, dirty/ahead-behind, provenance, indexing state, owning thread, PR pill and the actions that make it usable. Two **agent tools** (`brainstrike.listWorktrees`, `brainstrike.manageWorktree`) give a run the same create/list/archive surface the Mode chip has, with `created_by='agent'` and `run_id` provenance. And a **shell-output correlator** notices when the agent's own `executeCommand` ran `git worktree add` or `gh pr create`, adopts the resulting worktree into the ledger attributed to that run, and asks the forge for a fresh look — best-effort, labelled as such, never invented.

**Architecture:** No new state authority. `WorktreeService` (desktop main, landed in W3) gains three read/repair operations — `adopt`, `checkoutStatus`, `reconcileFromShell` — and `window.worktrees` grows from 9 to 11 exact-set methods (`reconcileFromShell` is main-internal and gets no bridge slot). The Map is a **pure projection**: one `worktrees.list()` refreshed on the existing `changes:invalidated` nonce, joined in a pure model against the already-landed `useForgePrCache` live query (keyed `(repoCommonDir, branch)`), the assistant thread store's `metadata.checkoutWorktreeId`, `useActiveAssistantThreadIds`, and the BST-1453 worktree-indexing preference map. The agent tools are ordinary native tools registered through the full ten-site catalog; their executors call the SAME `WorktreeService` the chip calls, injected into the desktop assistant server as a lazily-resolved option and closed over the request's `runId` — no second worktree code path. The correlator hangs off the `executeCommand` registration in `assistant-tools.ts`, scans only the model-supplied command string plus the tool's own result, and writes through the SAME `recordDesktopAssistantRunEvent` writer W3 already exports. Web has no `window.worktrees`, so the Map tab is never registered and the tools are absent from `WEB_NATIVE_TOOL_IDS`.

**Tech Stack:** TypeScript strict (no `any`), React 19 + Tailwind CSS v4, Radix Popover/DropdownMenu via `@brainstrike/ui`, Electron main/preload/renderer bridge domains, PGlite live queries, Zod tool schemas + Mastra tool registration, Vitest (unit + `*.integration.test.*`), Playwright desktop E2E, Chrome DevTools MCP for live verification, Biome/Ultracite.

**Linear:** epic [BST-1387](https://linear.app/brainstrike/issue/BST-1387) → W5 **[BST-1392](https://linear.app/brainstrike/issue/BST-1392)** — *"W5: Worktree Map workspace app + agent worktree tools + shell-output correlation"*, Backlog. **CONFIRMED by the coordinator against Linear (2026-08-26)**; used verbatim in every commit message. **Spec:** `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md` §2, §5.3, §5.4, §6.1, §6.2, §6.4, §10, §11, §12, §13, §14, §15 (W5 row), §16 (D5, D8, D11). **Depends on:** W3 (BST-1390) and W4 (BST-1391), both landed on `integration/workspace-checkout-awareness`.

> **Branch point (read before you start, and before you review):** **W5 branches from `integration/workspace-checkout-awareness` at or after `949f11331` (post-PR #2655, BST-1453).** That commit is where `worktreeRootIndexingOptInById`, `worktreeRootIndexingByAdapterRootId`, `setWorktreeRootIndexingEnabled` and `packages/file-explorer-ui/src/components/worktree-indexing-control.tsx` exist. A checkout that predates it will read this plan's Layer-2 references to those symbols as phantoms — they are not. Verify before starting:
>
> ```bash
> git merge-base --is-ancestor 949f11331 HEAD && echo "OK: post-#2655" || echo "STOP: rebase onto integration first"
> ```

---

## Global Constraints

Every task's requirements implicitly include this section.

- **NO SILENT FALLBACKS.** Every Map card that cannot be acted on says why, on screen, next to the disabled action — the `WorktreeListEntry.disabledReason` / `remedy` contract W3 established extends unchanged to the Map. A failed `worktrees.list()` renders an error row, never an empty Map. A failed per-card status read renders "status unavailable: <reason>", never a clean glyph. A correlation that cannot be attributed is logged and dropped, never guessed onto the wrong run.
- **Exact-set bridge pins.** `WORKTREES_BRIDGE_REQUIRED_METHODS` grows to 11 and stays pinned by `satisfies Record<keyof WorktreesBridge, true>` AND by `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`. The preload's exposed key set must equal it exactly; there is no optional bridge method.
- **Capability gating by omission, never `isElectron()`.** The Map tab registers only when `isWorktreesBridgeAvailable()` is true, exactly as Changes registers on `isChangesBridgeAvailable()`. Web registers no Map tab, gets no `window.worktrees`, and omits both agent tools from `WEB_NATIVE_TOOL_IDS`.
- **One worktree code path.** Agent tools, the Mode chip, and the correlator all call the same `WorktreeService`. No tool may shell out to `git worktree` itself, and no second ledger writer exists.
- **Every git invocation is `execFile('git')` in desktop MAIN** through `execFileGitRunner` + `createPinnedGitEnvironment`, and every worktree mutation goes through `invokeGitHookFree(invoke, args)` (`apps/desktop/src/assistant-server/git-service.ts`). Never `execFile` directly, never a shell string.
- **Run events go through the landed writer.** `recordDesktopAssistantRunEvent` (`apps/desktop/src/assistant-server/run-persistence.ts`) is the only main-side INSERT. It inherits the documented `if (runId)` gate and the "unknown parent run ⇒ 0 rows" no-op. No orphan row is invented for an operation outside a run.
- **New run-event kinds are tabled in the pairing contract.** Any kind added to `ASSISTANT_RUN_EVENT_KINDS` must be classified in `packages/assistant-ui/src/__tests__/assistant-run-event-pairing-contract.test.ts` (`NEVER_RUNNING` or `RUNNING_WITH_EXPLICIT_TERMINALS`) with an emitter-verified status comment. **This plan adds NO new kind** — see Resolved ambiguity A4.
- **Falsifying wiring tests.** Every "hook A calls service B" test uses a DISTINCT `vi.fn()` per method, asserts `toHaveBeenCalledTimes(1)` with the exact arguments, AND asserts the sibling mocks were `not.toHaveBeenCalled()`. A test that passes when the wiring is swapped is not a test.
- **TypeScript strict, no `any`.** `unknown` + narrowing at every IPC and tool-input boundary; discriminated unions over enums; kebab-case filenames; `use-*.ts` hooks exporting camelCase; components export PascalCase.
- **Biome:** `noExcessiveLinesPerFile` maxLines **1000** (error), ceiling-locked — **split, never register an override**. `apps/desktop/src/assistant-server/worktree-service.ts` (1011 physical lines), `assistant-tools.ts` (1004) and `packages/app-shell/src/hooks/use-workspace-bar.ts` (1031) are already at the ceiling, so this plan adds NO net lines to any of them beyond a handful of delegating lines; new behavior lands in new modules. Cognitive complexity ≤ 20. Object/JSX props sorted alphabetically. `pnpm dlx ultracite fix <files>` before every commit, and `pnpm dlx ultracite check <files>` to confirm the cap.
- **Testing lanes:** Vitest unit for pure logic, models and hooks; `*.integration.test.ts` for real-git and real-PGlite (excluded from the cached `test` lane, run by `test:integration`); Playwright desktop E2E. The assistant-ui full lane is `pnpm vitest run` for ALL projects, not a `-t` subset. **Live CDT verification is part of the definition of done for every UI task** — report COMPUTED VALUES (rects, `disabled`, `aria-*`, card counts, glyph text), never impressions.
- **Stack:** one branch per layer on trunk `integration/workspace-checkout-awareness`, created with `gh stack add`. NEVER target `main`. Land bottom-up. Commit messages `feat|fix|test|docs(BST-1392): …` with trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Gates before each PR:** touched packages' `test`, root `pnpm run type-check`, `pnpm run lint:eslint`, `pnpm dlx ultracite fix <files>`, `pnpm run react-doctor` (no NEW error-severity findings in touched files). Pristine output — no `act()` warnings, no unasserted logger lines.
- **Docs in-band**, in the same PR as the code: `docs/agents/changeset-diff.md` (Map surface + adoption + `primary`), `docs/agents/workspace-context.md` (Map tab registration, the checkout-intent seam), `docs/agents/assistant-providers.md` (the two new native tools + namespace), `docs/agents/assistant-persistence.md` (correlation provenance and the `via` metadata), `packages/agent/AGENTS.md` (tool documentation rule).
- `@mastra/core` stays Node-only/externalized; local inference stays renderer-only. Nothing here touches either.

---

## Scope boundaries (read before starting)

**In scope (W5):** the Worktree Map workspace app tab; `WorktreeListEntry` gaining `createdAt` / `primary` / `repoCommonDir`; `worktrees.adopt`; `worktrees.checkoutStatus`; the "New thread here" checkout-intent seam; `brainstrike.listWorktrees` + `brainstrike.manageWorktree`; `executeCommand` shell-output correlation for `git worktree add` and `gh pr create`; the `shell` forge refresh reason; Map PR pills; desktop E2E + CDT verification; docs.

**Explicitly OUT of scope (owner named):**
- **Open in Terminal** anywhere in the Map. W3 ruling A6 stands and was **re-affirmed by the coordinator (2026-08-26)**: there is no terminal-session seam yet, **W6 owns it**, and the menu item is **absent**, not a disabled stub. Absence is not left to reviewer memory — Task 6 carries an ABSENCE-ASSERTION test (the Task-14 tripwire pattern) that fails if a future edit reintroduces the item in any form.
- **Per-repository trust/consent before running a repository setup script** → BST-1455 (already filed). This plan does not touch `worktree-setup.ts`.
- **Run-scoped `git worktree lock`/`unlock`** → the W3 ruling A5 follow-up recorded in `docs/agents/changeset-diff.md`. The Map surfaces `lockedReason` read-only.
- **Indexing-on-by-default for worktree roots** → still gated on the BST-393 hash-reuse measurement [D8]. The Map renders the BST-1453 state and reuses its existing toggle action; it does not change the default.
- **Auto-fix / auto-merge loops** → forbidden in v1 by D5. The Map has no PR-mutating action.
- **`glab` / GitLab PR status** → follow-up; a `gitlab` remote already renders W4's stated "not supported yet" diagnostic.
- **Drag-drop, `File ▸ Open Recent`, `brainstrike <path>`** → W6 [D7, D10].
- **BST-1454 / BST-1455 / BST-1456** — open tickets adjacent to this epic. Do not implement their content here.

**Sibling-PR collisions to watch:** none in the migration space — W5 adds **no migration and no table**. Two kinds of overlap exist:

- *Within this plan:* `apps/desktop/src/assistant-server/assistant-tools.ts` (Layers 3 and 4) and `docs/agents/changeset-diff.md` (Layers 2 and 5) — both sequenced, never concurrent.
- *With W3 review work still in flight on `seandearnaley/bst-1390-w3-mode-chip` at the time of writing:* `packages/assistant-ui/src/workspace-bar/mode-chip.tsx`, `packages/assistant-ui/src/workspace-bar/worktree-picker-dialog.tsx`, `packages/assistant-ui/src/__tests__/mode-chip.test.tsx`, `packages/app-shell/src/hooks/use-worktree-mode.ts`, `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`, `apps/desktop/src/assistant-server/worktree-settings.ts`, `apps/desktop/src/main.ts`, `apps/desktop/e2e/worktree-mode.desktop.test.ts`. **Layer 1 Tasks 2 and 5 edit `use-worktree-mode.ts` and its test.** Confirm that branch has landed on integration before starting Layer 1, and re-read those two files rather than applying this plan's diffs blind — the picker's `onSelectExisting` body in Task 2 Step 8 is a full replacement written against the landed W3/19 shape.

---

## Resolved spec ambiguities (read before Task 1)

| # | Ambiguity | Resolution used by this plan |
| --- | --- | --- |
| A1 | §10 wants the Map's lane to start with the **Primary checkout** card, but `WorktreeListEntry` has no way to say which row is the primary — and `list()` DOES return it, because `git worktree list --porcelain` enumerates the main worktree alongside the linked ones. | **`WorktreeListEntry.primary: boolean`** (Task 1), computed as `descriptor.path === repository.identity.repositoryRoot`. **Corrected at Task 2/3 execution:** this table originally worried that Task 2 would "open a path" where selecting the primary in the picker could adopt it, and framed Task 1's primary gate as landing BEFORE that path opened. A Task 2 review round found the opposite — `resolveUsability` marks EVERY row without a ledger id `usable: false` (primary or not), and `worktree-picker-dialog.tsx` disables the option's button whenever `!usable`, so `onSelectExisting` could never fire for ANY unmanaged row through a real click, primary included. Task 2's picker-side adopt call was therefore dead code from the moment it landed and was removed (`fix(BST-1392): remove the unreachable picker adoption branch`); adoption now surfaces only on the Worktree Map's card action (Task 6) and the `worktrees:adopt` agent tool (Task 10), never the picker. Task 1's primary gate is still exactly right, just for a narrower, sturdier reason than originally argued: it gives the primary its OWN stated reason ("This is the repository's primary checkout — use Hand off to Local instead.") instead of the generic unmanaged-row message, so the Mode chip is honest about WHY, and `adoptWorktree` (Task 2) independently refuses `descriptor.path === repositoryRoot` too — the primary can never be adopted through any surface, including a future direct agent-tool call that bypasses UI disabling entirely, by construction rather than by picker-disabling alone. |
| A2 | §10 wants a **PR pill** on each card, but the landed PR cache is keyed `(repo_common_dir, branch)` and `WorktreeListEntry` exposes only `repositoryRoot`. | **`WorktreeListEntry.repoCommonDir: string`** (Task 1), taken from `repository.identity.gitCommonDir` for scanned rows and `row.repoCommonDir` for ghost rows. The Map then joins the ALREADY-LANDED `useForgePrCache` map with `forgePrCacheKey(repoCommonDir, branch)` — the same key and the same `rollupForgeChecks` the thread pill uses, so the two surfaces cannot disagree. No new forge query, no new forge IPC. |
| A3 | §10 wants **dirty/unpushed glyphs** per card. Running the archive-safety probe for every worktree on every list would put N git subprocesses behind a surface that refreshes on every `changes:invalidated`. | A separate, **lazy, per-card** `worktrees:checkoutStatus` op (Task 3) returning `{ ahead, behind, clean, path, upstream }` from ONE `git status --porcelain=v2 --branch -z`, parsed by the already-exported `parsePorcelainV2Z`. The Map requests it per visible card with bounded concurrency, and re-requests only when the invalidation nonce for that repository changes. `list()` stays cheap. Until a card's status resolves it renders "checking…", never a clean glyph. |
| A4 | §6.4 wants a timeline event *"Agent created worktree X (via shell)"*, which reads like a new run-event kind. | **No new kind.** The correlator emits the existing `worktree.created` with `metadata.via: 'shell'` (the ledger-backed create emits `via: 'app'`, the agent tool `via: 'tool'`, adoption `via: 'adopt'`). A new kind would need a pairing-contract row and a second label vocabulary for the same fact. The pairing contract is therefore untouched, and `docs/agents/assistant-persistence.md` records the `via` vocabulary. |
| A5 | §6.4 says the **inventory watcher's `worktrees/<name>` lifecycle events are correlated to the active run**. | **Deliberately not implemented from the watcher.** `GitInventoryInvalidation` carries `{ gitCommonDir, repositoryRoot }` only: no worktree path, no create-vs-remove discrimination (a bare `worktrees/<name>` appearing and disappearing collapse to the same string), and a 300–2000 ms debounce coalesces N operations into one signal. Correlating that to a run would be a temporal guess. The **shell tool's own result** is the strong signal and is what this plan uses; the watcher keeps doing its existing job (refreshing the Map). Recorded in `docs/agents/assistant-persistence.md`. |
| A6 | §6.4 names **three** agent tools (`createWorktree`, `listWorktrees`, `archiveWorktree`), all "execute-risk → permission engine". | **Two ids.** `brainstrike.listWorktrees` is `category: 'analysis'`, `riskCategory: 'read'`, no approval — a run orienting itself must be able to list worktrees in plan mode, and classifying a read as execute would make that impossible. `brainstrike.manageWorktree` is an `action` discriminated union (`create` \| `archive`), `riskCategory: 'execute'`, `requiresApproval: true` — the mutations reach the permission engine exactly as §6.4 requires. This is the settled `manageCanvas` shape (strict provider envelope delegating to a discriminated union) and costs two prompt-budget slots instead of three. **This is a DELIBERATE, coordinator-ACCEPTED deviation from the literal text of §6.4 (2026-08-26) — do not relitigate:** §6.4's protective intent is that MUTATIONS gate through the permission engine, which `manageWorktree` preserves in full, while classifying a read-only listing as execute-risk would block plan-mode orientation for no protective gain whatsoever. |
| A7 | §10's **"Add as root"** implies an adoption path, and the Mode chip's picker states the reason "Created outside BrainStrike — adopting it is coming with the Worktree Map." next to a disabled unmanaged row — **corrected at Task 2/3 execution: this is a static label, never a "live toast"** (the row's select button is disabled whenever `!usable`, which is true for every unmanaged row including the primary, so nothing ever fires a toast for clicking one — the original A7 wording conflated this string with `onSelectExisting`'s now-removed placeholder-toast copy, which likewise never fired for the same reason). Either way, `useThreadCheckout.selectWorktree` requires a ledger `worktreeId`, so an externally created worktree cannot be checked out even when it is perfectly usable. | **`worktrees:adopt`** (Task 2) inserts a ledger row for an existing on-disk worktree. It REFUSES a path that is outside every granted root AND outside the managed directory, because `resolveUsability` treats "has a ledger row" as authorization — adopting an unreachable path would make an ungrantable row read `usable: true` — and it independently refuses the repository's own primary checkout too (see A1's correction). `base_ref` is recorded as the worktree's HEAD sha at adoption time, and the migration doc comment already says `base_ref` means "the ref unpushed work is measured against"; "since adoption" is the honest reading for a worktree the app did not create. **The service/bridge method landed in Task 2, but no UI called it until Task 6**: the picker's own call turned out to be unreachable (A1) and was removed, so the Worktree Map's card `onAdopt` action is the FIRST real caller, with the agent tool (Task 10) the second. The picker's stated reason is accurate today but becomes forward-looking-copy-that-should-now-be-true once Task 6 ships the Map — revisiting that string is out of scope here and left for whoever lands Task 6. |
| A8 | §8's `ForgeRefreshReason` union is `'invalidation' \| 'user' \| 'window'`, and the IPC validator's `satisfies Record<ForgeRefreshReason, true>` means adding a member automatically makes it renderer-supplied. | The union splits: `ForgeRendererRefreshReason = 'invalidation' \| 'user' \| 'window'` (what the bridge accepts) and `ForgeRefreshReason = ForgeRendererRefreshReason \| 'shell'` (what the service accepts). `'shell'` has a 0 ms floor and is reachable ONLY from main's correlator; a renderer that sends it gets the existing stated refusal. |
| A9 | §10's **"New thread here"** must create a thread AND bind its checkout, but the checkout writer (`useThreadCheckout`) is mounted in the composer's `useWorkspaceBar`, in a different component tree from the Map. | A one-shot **checkout-intent store** (`packages/app-shell/src/stores/worktree-checkout-intent-store.ts`): the Map publishes `{ branch, path, threadId, worktreeId }`, `useWorkspaceBarMode` consumes it exactly once for the matching selected thread and calls the SAME `onSelectWorktree`. This is the `changes-navigation-store` idiom (cross-surface intent, not a second writer). Consumption is idempotent and the entry is cleared before the async write starts, so a re-render cannot double-write. |
| A10 | §10's **"last activity"**. Nothing in the inventory or the ledger records worktree activity, and a per-card `git log -1` is another N subprocesses. | Last activity = the owning thread's `updatedAt` when a thread occupies the worktree, else the ledger `createdAt` (labelled "Created"), else **nothing rendered**. Both facts are already in hand (the thread store and the new `WorktreeListEntry.createdAt`); nothing is invented and no git call is added. |
| A11 | §10 lists **Hand off** as a card action, but hand-off is a per-thread metadata write owned by `useThreadCheckout` (W3 ruling A6: main has no business writing `mastra_threads.metadata`). | The Map's Hand off is offered ONLY on the card whose worktree is the SELECTED thread's checkout, and it routes through the same intent store with `worktreeId: null` (meaning "return to Local"), which `useWorkspaceBarMode` turns into `onHandOffToLocal()`. Cards belonging to other threads offer **Open thread** instead, with the tooltip "Switch to this thread to hand it off." |
| A12 | §12 says web omits the Map. `RootLayoutContentProps` is shared. | The Map arrives exactly like Changes: an optional `worktreeMapPageContent?: ReactNode` prop that ONLY `apps/desktop/src/renderer/components/root-layout-content.tsx` supplies, behind `isWorktreesBridgeAvailable()`. `buildWorkspaceApps` registers the tab only when the content exists. Web passes nothing and the "+" menu never lists it — registration IS the capability gate. |

---

## Dependency DAG (execution order and what may run in parallel)

```
                    ┌──────────────────────────────────────────┐
                    │ L1  map-contracts   (Tasks 1–3)          │  ← sequential base
                    │ types + WorktreeService + bridge (9→11)  │
                    └───────────────┬──────────────────────────┘
                                    │
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
  ┌───────────────────────────┐              ┌────────────────────────────┐
  │ L2  worktree-map          │              │ L3  agent-tools            │
  │ (Tasks 4–7)               │   PARALLEL   │ (Tasks 8–10)               │
  │ app-shell + assistant-ui  │◄────────────►│ assistant-contract + agent │
  │ + desktop renderer        │  file-       │ + desktop assistant-server │
  └───────────┬───────────────┘  disjoint    └───────────┬────────────────┘
              │                                          │
              │                                          ▼
              │                              ┌────────────────────────────┐
              │                              │ L4  shell-correlation      │
              │                              │ (Tasks 11–12)              │
              │                              │ shares assistant-tools.ts  │
              │                              └───────────┬────────────────┘
              └───────────────────┬──────────────────────┘
                                  ▼
                    ┌──────────────────────────────────────────┐
                    │ L5  verification (Tasks 13–14)           │
                    │ desktop E2E + CDT + docs                 │
                    └──────────────────────────────────────────┘
```

**Parallel-execution rules for a fleet:**

- **L2 ∥ L3 are genuinely independent.** Their file sets are disjoint: L2 touches `packages/app-shell/src/worktree-map/**`, `packages/app-shell/src/stores/`, `packages/app-shell/src/hooks/use-workspace-bar-mode.ts`, `packages/app-shell/src/build-workspace-apps.tsx`, `packages/app-shell/src/root-layout-content.tsx`, `packages/file-explorer-ui/src/shell/workspace-app.ts`, `apps/desktop/src/renderer/components/**`, and (via Layer 2 Step 0) `packages/app-state/src/stores/background-indexing-preferences-store.ts`, `packages/app-state/src/factory-reset.ts`, `packages/app-state/src/__tests__/factory-reset-*.test.ts`, `docs/agents/platform-contracts.md`. L3 touches `packages/assistant-contract/src/*tool*`, `packages/agent/src/tools/**`, `packages/agent/src/mastra/**`, `apps/desktop/src/assistant-server/worktree-tools.ts`, `assistant-tools.ts`, `assistant-server.ts`, `main.ts`. Run them in two isolated worktrees. The only shared file is `packages/types/src/worktree.ts`, which L1 already finished; neither layer edits it again.
- **L4 is strictly after L3** — both edit `apps/desktop/src/assistant-server/assistant-tools.ts` and `DesktopAssistantToolDependencies`, and L4's correlator reuses the `runId`-closured dependency L3 introduces.
- **Within a layer, tasks are sequential.** L1's three tasks all edit `worktree-service.ts` + `worktrees-ipc-handlers.ts` + `worktrees-bridge.ts` + `preload.ts`. L2's four tasks all build up `packages/app-shell/src/worktree-map/`. L3's three tasks are catalog → schemas → registry, each depending on the previous compile.
- **Landing order is linear** (`gh stack`): L1 → L2 → L3 → L4 → L5. A layer developed in parallel is rebased onto the layer below before `gh stack submit`.

---

## File structure (what each unit owns)

**Created**

| File | Responsibility |
| --- | --- |
| **Layer 1** | |
| `apps/desktop/src/assistant-server/worktree-adopt.ts` | `adoptWorktree`, `readCheckoutStatus`, `reconcileWorktreesFromShell` — kept out of `worktree-service.ts`, which is already at the 1000-line ceiling. |
| `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts` | Pure/mocked unit lane for the three operations. |
| `apps/desktop/src/__tests__/assistant-server/worktree-adopt.integration.test.ts` | Real-git lane: adopt an external worktree, read its status. |
| **Layer 2** | |
| `packages/app-shell/src/stores/worktree-checkout-intent-store.ts` | One-shot cross-surface checkout intent [A9]. |
| `packages/app-shell/src/worktree-map/worktree-map-model.ts` | Pure projection: entries + PR cache + threads + indexing → repository lanes. |
| `packages/app-shell/src/worktree-map/use-worktree-checkout-status.ts` | Bounded-concurrency lazy per-card status reads. |
| `packages/app-shell/src/worktree-map/use-worktree-map.ts` | Composition hook: bridge list + live refresh + all joins. |
| `packages/app-shell/src/worktree-map/worktree-map-card.tsx` | One checkout card + its action menu. |
| `packages/app-shell/src/worktree-map/worktree-map-surface.tsx` | The screen: repository sections, lanes, empty/error states. |
| `packages/app-shell/src/worktree-map/index.ts` | Public barrel for the lazy desktop import. |
| `apps/desktop/src/renderer/components/worktree-map-page-content.tsx` | Lazy `Suspense` wrapper (mirrors `changes-page-content.tsx`). |
| **Layer 3** | |
| `packages/agent/src/tools/schemas-worktrees.ts` | Zod schemas + `normalizeManageWorktreeInput`. |
| `apps/desktop/src/assistant-server/worktree-tools.ts` | `runListWorktrees`, `runManageWorktree`, `buildWorktreeMastraTools`. |
| `apps/desktop/src/__tests__/assistant-server/worktree-tools.test.ts` | Executor unit lane. |
| **Layer 4** | |
| `packages/assistant-contract/src/shell-git-correlation.ts` | Pure scanner over a command string + tool output. |
| `packages/assistant-contract/src/__tests__/shell-git-correlation.test.ts` | Scanner unit lane. |
| `apps/desktop/src/assistant-server/shell-worktree-correlation.ts` | The effectful correlator (reconcile + run event + forge refresh). |
| `apps/desktop/src/__tests__/assistant-server/shell-worktree-correlation.test.ts` | Correlator unit lane. |
| **Layer 5** | |
| `apps/desktop/e2e/worktree-map.desktop.test.ts` | Desktop E2E for the Map tab, adoption and the agent tool. |
| `scripts/probe-worktree-map.mjs` | CDT computed-value probe. |

**Modified**

| File | Change |
| --- | --- |
| `packages/types/src/worktree.ts` | `WorktreeListEntry` + `createdAt`/`primary`/`repoCommonDir`; `WorktreeAdoptParams`, `WorktreeCheckoutStatus`, `WorktreeShellReconcileResult`. |
| `packages/types/src/forge.ts` | Split `ForgeRendererRefreshReason` out of `ForgeRefreshReason`; add `'shell'` [A8]. |
| `apps/desktop/src/assistant-server/worktree-service.ts` | Pass `gitCommonDir` into the entry builders; primary gate; delegate `adopt`/`checkoutStatus`/`reconcileFromShell`. |
| `apps/desktop/src/assistant-server/forge-service.ts` | `shell: 0` floor. |
| `apps/desktop/src/forge-ipc-handlers.ts` | Validator pinned to `ForgeRendererRefreshReason`. |
| `packages/app-shell/src/forge/forge-bridge.ts` | `refresh` takes `ForgeRendererRefreshReason`. |
| `apps/desktop/src/worktrees-ipc-handlers.ts`, `ipc-worktrees.ts`, `platform/desktop-ipc-channels.ts`, `preload.ts` | Two new channels + handlers. |
| `packages/app-shell/src/worktrees/worktrees-bridge.ts` | 9 → 11 exact-set methods. |
| `apps/desktop/src/__tests__/preload-runtime-contract.test.ts` | Channel-literal + bridge key-set parity. |
| `packages/app-shell/src/hooks/use-worktree-mode.ts` | Picker adoption path added in Task 2, then removed as unreachable (A1/A7) — the placeholder toast becomes a defensive refusal instead. Adoption's real home is Task 6's Map card `Adopt` action. |
| `packages/app-shell/src/hooks/use-workspace-bar-mode.ts` | Mount the checkout-intent consumer. |
| `packages/file-explorer-ui/src/shell/workspace-app.ts` | `WORKTREE_MAP_APP_ID`. |
| `packages/app-shell/src/build-workspace-apps.tsx` | Register the Map tab. |
| `packages/app-shell/src/root-layout-content.tsx` | `worktreeMapPageContent` prop. |
| `packages/app-shell/package.json` | `./worktree-map` export. |
| `apps/desktop/src/renderer/components/root-layout-content.tsx` | Capability gate + prop. |
| `packages/assistant-contract/src/native-tool-catalog.ts`, `tool-categories.ts`, `tool-descriptions.ts`, `tool-discovery.ts`, `tool-schemas-display-workspace.ts` | The two new tool ids across all five catalog sites. |
| `packages/agent/src/tools/schemas.ts`, `packages/agent/src/index.ts`, `packages/agent/src/mastra/deferred-capability-families.ts` | Schema map, exports, capability family. |
| `apps/desktop/src/assistant-server/assistant-tools.ts` | `worktreeTools` dependency + one spread; `executeCommand` correlation hook. |
| `apps/desktop/src/assistant-server/server-options.ts`, `assistant-server.ts`, `main.ts` | Lazy `resolveWorktreeService` / `resolveForgeService` option, request-scoped capability construction. |
| `apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts` | Ledger paragraph, `eagerToolCount`, aggregate bands. |
| `apps/desktop/src/__tests__/assistant-server/assistant-tools-multiroot-and-gating.integration.test.ts` | Registry parity fixture. |
| `docs/agents/changeset-diff.md`, `workspace-context.md`, `assistant-providers.md`, `assistant-persistence.md`, `packages/agent/AGENTS.md` | In-band contract updates. |

---

# Layer 1 — Map data contracts and the two new worktree operations

**Branch:** `seandearnaley/bst-1392-w5-map-contracts`

```bash
git checkout integration/workspace-checkout-awareness && git pull
gh stack init --base integration/workspace-checkout-awareness seandearnaley/bst-1392-w5-map-contracts
```

---

### Task 1: `WorktreeListEntry` gains identity, age and the primary gate

**Files:**
- Modify: `packages/types/src/worktree.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/__tests__/assistant-server/worktree-service.integration.test.ts`
- Modify: `packages/app-shell/src/hooks/use-worktree-mode.ts`
- Modify: `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`

**Interfaces:**
- Consumes: `GitInventoryRepository.identity.gitCommonDir`, `ManagedWorktreeRow.createdAt`.
- Produces, exported from `@brainstrike/types`:
  - `WorktreeListEntry` gains
    - `readonly createdAt: string | null;` — ledger creation stamp, `null` for a purely scanned worktree.
    - `readonly primary: boolean;` — this checkout IS the repository's main worktree.
    - `readonly repoCommonDir: string;` — realpath'd git common dir; the `brainstrike_forge_prs` join key.

> **(corrected at execution: the mocked unit suite never existed; integration lane is the convention.)**
> `apps/desktop/src/__tests__/assistant-server/worktree-service.test.ts` and its `describe('createWorktreeService')`
> block, `makeService()` helper, and `worktreeDescriptor`/`managedRow` fixture builders do not exist anywhere in this
> repository's history — this plan's Step 1 was drafted against an imagined mocked seam. The repo's actual
> convention (see `worktree-service.integration.test.ts`'s own header comment) is real git + real PGlite via the
> shared fixture kit in `worktree-service.shared.ts` (`createTestWorkspace()`, `buildTestService()`,
> `asLedgerDatabase()`, `git(cwd, args)`). Steps 1-2 below target `worktree-service.integration.test.ts` instead,
> keeping every assertion value from the original brief — only the fixture mechanics changed from mocked
> `GitInventory`/`ManagedWorktreeRow` literals to a real repo + real ledger rows.

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/__tests__/assistant-server/worktree-service.integration.test.ts` (inside the existing
`describe('WorktreeService (real git + real PGlite)')` block — reuse that file's existing `buildService()` closure,
`workspace`/`repo`/`managedDirectory` fixtures, and the `descriptor(...)` builder pattern already used by the
"joins a realistic inventory" test):

```ts
  it('marks the repository main worktree as the primary and refuses it as a checkout target', async () => {
    const created = await buildService().create({
      baseRef: 'main',
      branch: { name: 'bs/primary-gate' },
      createdBy: 'user',
      name: 'primary-gate',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: created.value.worktree.repoCommonDir, repositoryRoot: repo },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'repo',
              path: repo,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
            {
              bare: false,
              branch: 'bs/primary-gate',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'primary-gate',
              path: created.value.worktree.path,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    } satisfies GitInventory;

    const listed = await buildService({ resolveInventory: () => Promise.resolve(inventory) }).list();

    expect(listed.ok).toBe(true);
    const entries = listed.ok ? listed.value : [];
    const primary = entries.find((entry) => entry.path === repo);
    expect(primary?.primary).toBe(true);
    expect(primary?.usable).toBe(false);
    expect(primary?.disabledReason).toBe(
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
    expect(entries.find((entry) => entry.path === created.value.worktree.path)?.primary).toBe(false);
  });

  it('carries the repository common dir and the ledger creation stamp onto every entry', async () => {
    const commonDir = realpathSync(
      git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    );
    const created = await buildService().create({
      baseRef: 'main',
      branch: { name: 'bs/carries-stamp' },
      createdBy: 'user',
      name: 'carries-stamp',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const ledger = createWorktreeLedger(() => Promise.resolve(asLedgerDatabase(db)));
    await ledger.insert({
      archivedAt: null,
      archiveSnapshotRef: null,
      baseRef: 'main',
      branch: 'bs/ghost-stamp',
      createdAt: '2026-08-25T00:00:00.000Z',
      createdBy: 'user',
      id: '01993a12-0000-7000-8000-000000000021',
      path: '/gone',
      repoCommonDir: '/elsewhere/.git',
      runId: null,
      setupOutput: null,
      setupReason: null,
      setupStatus: 'none',
      threadId: null,
    });
    const inventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: created.value.worktree.repoCommonDir, repositoryRoot: repo },
          worktrees: [
            {
              bare: false,
              branch: 'bs/carries-stamp',
              containment: ['r-1'],
              current: false,
              detached: false,
              head: '0123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'carries-stamp',
              path: created.value.worktree.path,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    } satisfies GitInventory;

    const listed = await buildService({ resolveInventory: () => Promise.resolve(inventory) }).list();

    expect(listed.ok).toBe(true);
    const entries = listed.ok ? listed.value : [];
    const scanned = entries.find((entry) => entry.path === created.value.worktree.path);
    expect(scanned?.repoCommonDir).toBe(commonDir);
    expect(scanned?.createdAt).toBe(created.value.worktree.createdAt);
    const ghost = entries.find((entry) => entry.path === '/gone');
    // The ghost row keeps the LEDGER's own common dir — the inventory has no
    // descriptor for it, so there is nothing else that could be honest here.
    expect(ghost?.repoCommonDir).toBe('/elsewhere/.git');
    expect(ghost?.primary).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-service.integration.test.ts
```

Expected: both new cases fail — `Property 'primary' does not exist on type 'WorktreeListEntry'` at type-check, and at runtime `expect(primary?.primary).toBe(true)` receives `undefined`.

- [ ] **Step 3: Extend the contract**

In `packages/types/src/worktree.ts`, inside `interface WorktreeListEntry` (keep the properties alphabetically sorted — Biome enforces it):

```ts
  readonly containment: readonly string[] | 'outside-roots';
  /** Ledger creation stamp (ISO-8601); null for a purely scanned worktree. */
  readonly createdAt: string | null;
  readonly detached: boolean;
```

…and, after `readonly path: string;`:

```ts
  /**
   * True when this checkout is the repository's MAIN worktree, not a linked
   * one. `git worktree list` enumerates it, so it reaches every consumer of
   * this list; the Worktree Map renders it as the lane's first card, and the
   * Mode chip's picker refuses it as a checkout target (a thread that wants
   * the primary checkout is in Local mode, by definition).
   */
  readonly primary: boolean;
  readonly provenance: WorktreeProvenance;
  readonly remedy: 'grant-access' | null;
  /**
   * Realpath'd git common dir — the repository identity `brainstrike_worktrees`
   * and `brainstrike_forge_prs` both key on. Distinct from `repositoryRoot`
   * (the main worktree path): the PR cache joins on THIS.
   */
  readonly repoCommonDir: string;
  readonly repositoryRoot: string;
```

- [ ] **Step 4: Produce the three fields in the service**

In `apps/desktop/src/assistant-server/worktree-service.ts`, thread the common dir through `listUnserialized`'s loop:

```ts
    for (const repository of inventory.repositories) {
      for (const descriptor of repository.worktrees) {
        seenPaths.add(descriptor.path);
        const row = rowsByPath.get(descriptor.path) ?? null;
        entries.push(
          inventoryListEntry(
            descriptor,
            row,
            repository.identity.repositoryRoot,
            repository.identity.gitCommonDir,
            rootIdByPath
          )
        );
      }
    }
```

Then widen `inventoryListEntry` and add the three fields plus the primary gate:

```ts
function inventoryListEntry(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null,
  repositoryRoot: string,
  repoCommonDir: string,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  const primary = descriptor.path === repositoryRoot;
  const gate = primary ? PRIMARY_CHECKOUT_GATE : resolveUsability(descriptor, row);
  return {
    branch: descriptor.branch,
    containment: descriptor.containment,
    createdAt: row?.createdAt ?? null,
    detached: descriptor.detached,
    disabledReason: gate.disabledReason,
    externalTool: externalToolForPath(descriptor.path),
    id: row?.id ?? null,
    lockedReason: descriptor.lockedReason,
    managed: row !== null,
    name: descriptor.name,
    path: descriptor.path,
    primary,
    // The FIRST producer of anything but 'scanned' (see
    // docs/agents/changeset-diff.md): a scanned worktree that also has a
    // ledger row is known from BOTH sides.
    provenance: row ? 'both' : 'scanned',
    remedy: gate.remedy,
    repoCommonDir,
    repositoryRoot,
    rootId:
      rootIdByPath.get(descriptor.path) ??
      (descriptor.containment === 'outside-roots' ? null : (descriptor.containment[0] ?? null)),
    setupReason: row?.setupReason ?? null,
    setupStatus: row?.setupStatus ?? 'none',
    trust: descriptor.trust,
    trustReason: descriptor.trustReason,
    usable: gate.usable,
  };
}
```

Declare the gate beside `UsabilityGate` (it is a constant, not a branch inside `resolveUsability`, so the primary reason can never be shadowed by a lower-priority cause):

```ts
/**
 * The primary checkout is enumerated by `git worktree list` like any other
 * worktree, but it is NOT a worktree-mode target: a thread that operates in
 * the user's own clone is in Local mode. Selecting it would write
 * `checkoutMode: 'worktree'` pointing at the primary, which the hand-off path
 * would then refuse to leave. Stated, never hidden (spec §13).
 */
const PRIMARY_CHECKOUT_GATE: UsabilityGate = {
  disabledReason: "This is the repository's primary checkout — use Hand off to Local instead.",
  remedy: null,
  usable: false,
};
```

And in `ghostListEntry` add the three fields (a ghost is never the primary — the primary cannot be missing from disk while its repository is in the inventory):

```ts
  return {
    branch: row.branch,
    containment: 'outside-roots',
    createdAt: row.createdAt,
    detached: row.branch === null,
    disabledReason: 'Worktree is missing on disk — restore it or archive it.',
    externalTool: externalToolForPath(row.path),
    id: row.id,
    lockedReason: null,
    managed: true,
    name: path.basename(row.path),
    path: row.path,
    primary: false,
    provenance: 'agent-reported',
    remedy: null,
    repoCommonDir: row.repoCommonDir,
    repositoryRoot: repositoryRootFromCommonDir(row.repoCommonDir),
    rootId: rootIdByPath.get(row.path) ?? null,
    setupReason: row.setupReason,
    setupStatus: row.setupStatus,
    trust: 'unvalidated',
    trustReason: 'missing on disk',
    usable: false,
  };
```

- [ ] **Step 5: Keep the picker honest about the primary row**

`useWorktreeMode`'s `toOption` already refuses to invent a reason for an unusable row, so the primary flows through as a disabled row with the stated reason and needs no change there. Add ONE assertion to `packages/app-shell/src/__tests__/use-worktree-mode.test.ts` so the behavior is pinned at the surface the user sees:

```ts
  it('renders the primary checkout as a disabled picker row with its stated reason', async () => {
    listMock.mockResolvedValue({
      ok: true,
      value: [
        entry({
          disabledReason:
            "This is the repository's primary checkout — use Hand off to Local instead.",
          id: null,
          name: 'brainstrike',
          path: '/repo',
          primary: true,
          usable: false,
        }),
      ],
    });

    const { result } = renderHook(() => useWorktreeMode(args));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));

    const [option] = result.current?.picker.options ?? [];
    expect(option?.usable).toBe(false);
    expect(option?.disabledReason).toBe(
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
  });
```

Update that file's `entry(...)` fixture factory to supply the three new fields (`createdAt: null`, `primary: false`, `repoCommonDir: '/repo/.git'`) by default.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-service.integration.test.ts
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/use-worktree-mode.test.ts
```

Expected: all green, including the two new desktop cases and the new app-shell case.

- [ ] **Step 7: Type-check the whole graph**

```bash
pnpm run type-check
```

Expected: clean. Every `WorktreeListEntry` literal in the repo must now supply the three fields — the compiler enumerates the ones you missed. At the time of writing that is exactly two production sites (`inventoryListEntry`, `ghostListEntry`) plus the fixture factory in `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`. `worktree-service.integration.test.ts` builds `WorktreeDescriptor`/`GitInventory` literals, not `WorktreeListEntry` ones (its assertions read `WorktreeListEntry` values back from the real `service.list()` call), so the compiler will not flag anything there. The desktop E2E suites build no `WorktreeListEntry` literal either, and the `assistant-ui` picker/chip tests build `WorkspaceBarWorktreeOption`, a different type this task does not touch — do not go looking for edits there.

- [ ] **Step 8: Commit**

```bash
pnpm dlx ultracite fix packages/types/src/worktree.ts apps/desktop/src/assistant-server/worktree-service.ts packages/app-shell/src/hooks/use-worktree-mode.ts
pnpm dlx ultracite check apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1392): worktree entries carry repo identity, age and the primary gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

`ultracite check` on `worktree-service.ts` is not optional here: the file starts at 1011 physical lines and this task is net-neutral only because the gate constant replaces an inline branch. If it reports `noExcessiveLinesPerFile`, move `inventoryListEntry`/`ghostListEntry`/`resolveUsability` into `worktree-adopt.ts` (Task 2 creates it) rather than registering an override.

---

### Task 2: `worktrees:adopt` — an existing worktree becomes a ledger row

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-adopt.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`
- Modify: `packages/types/src/worktree.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/worktrees-ipc-handlers.ts`, `apps/desktop/src/ipc-worktrees.ts`, `apps/desktop/src/platform/desktop-ipc-channels.ts`, `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts` — the `worktrees?: { … }` window declaration enumerates the bridge methods BY HAND and is not derived from `WorktreesBridge`, so an omission here is a silent renderer-side type gap rather than a compile error in main. Add `adopt` and `checkoutStatus` with the same signatures the bridge declares.
- Modify: `apps/desktop/src/assistant-server/worktree-run-events.ts` (the `worktree.created` adopt emitter)
- Modify: `packages/app-shell/src/worktrees/worktrees-bridge.ts`
- Modify: `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`
- Modify: `packages/app-shell/src/hooks/use-worktree-mode.ts`, `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`

**Interfaces:**
- Produces, exported from `@brainstrike/types`:
  - `interface WorktreeAdoptParams { readonly createdBy: ManagedWorktreeCreator; readonly path: string; readonly runId?: string; readonly threadId?: string }`
- Produces, exported from `apps/desktop/src/assistant-server/worktree-adopt.ts`:
  - `interface WorktreeAdoptDeps { readonly ledger: WorktreeLedger; readonly readSettings: () => Promise<WorktreeSettings>; readonly resolveInventory: () => Promise<GitInventory>; readonly resolveRootPaths: () => Promise<readonly { readonly id: string; readonly path: string }[]>; readonly run: GitCommandRunner }`
  - `function adoptWorktree(deps: WorktreeAdoptDeps, params: WorktreeAdoptParams): Promise<GitResult<ManagedWorktreeRow>>`
- Produces on `WorktreeService`: `adopt(params: WorktreeAdoptParams): Promise<GitResult<ManagedWorktreeRow>>`
- Produces on `WorktreesBridge`: `adopt: (params: WorktreeAdoptParams) => Promise<GitResult<ManagedWorktreeRow>>`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`:

```ts
import type { GitInventory, ManagedWorktreeRow, WorktreeSettings } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptWorktree } from '../../assistant-server/worktree-adopt';

const SETTINGS: WorktreeSettings = {
  isDefaultDirectory: true,
  managedDirectory: '/managed',
  setupCommand: null,
};

function inventory(worktrees: readonly { path: string; trust?: 'unvalidated' | 'validated' }[]) {
  return {
    errors: [],
    repositories: [
      {
        identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        worktrees: worktrees.map((worktree) => ({
          branch: 'feature',
          containment: ['root-1'] as readonly string[],
          current: false,
          detached: false,
          head: 'abc123',
          lockedReason: null,
          name: worktree.path.split('/').at(-1) ?? '',
          path: worktree.path,
          provenance: 'scanned' as const,
          prunableReason: null,
          trust: worktree.trust ?? ('validated' as const),
          trustReason: null,
        })),
      },
    ],
  } satisfies GitInventory;
}

function makeDeps(overrides: {
  readonly getByPath?: (path: string) => Promise<ManagedWorktreeRow | null>;
  readonly inventoryValue?: GitInventory;
  readonly rootPaths?: readonly { readonly id: string; readonly path: string }[];
}) {
  const insert = vi.fn(async (row: ManagedWorktreeRow) => row);
  const getByPath = vi.fn(overrides.getByPath ?? (() => Promise.resolve(null)));
  const run = vi.fn(async () => ({ exitCode: 0, signal: null, stderr: '', stdout: 'deadbeef\n' }));
  return {
    deps: {
      ledger: { getByPath, insert } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(overrides.inventoryValue ?? inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () => Promise.resolve(overrides.rootPaths ?? [{ id: 'root-1', path: '/repo' }]),
      run,
    },
    getByPath,
    insert,
    run,
  };
}

describe('adoptWorktree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a ledger row for an in-root scanned worktree, recording HEAD as the base ref', async () => {
    const { deps, insert, run } = makeDeps({});

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0]?.[0];
    expect(row?.baseRef).toBe('deadbeef');
    expect(row?.branch).toBe('feature');
    expect(row?.createdBy).toBe('user');
    expect(row?.path).toBe('/repo/wt');
    expect(row?.repoCommonDir).toBe('/repo/.git');
    expect(row?.setupStatus).toBe('none');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a worktree the inventory does not know', async () => {
    const { deps, insert } = makeDeps({});

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/elsewhere/wt' });

    expect(result).toEqual({
      error:
        'No worktree at "/elsewhere/wt" is visible in the workspace inventory, so it cannot be adopted.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses an unvalidated worktree', async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: inventory([{ path: '/repo/wt', trust: 'unvalidated' }]),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('could not be verified');
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a worktree outside every root and outside the managed directory', async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: {
        errors: [],
        repositories: [
          {
            identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
            worktrees: [
              {
                branch: 'feature',
                containment: 'outside-roots',
                current: false,
                detached: false,
                head: 'abc123',
                lockedReason: null,
                name: 'wt',
                path: '/tmp/wt',
                provenance: 'scanned',
                prunableReason: null,
                trust: 'validated',
                trustReason: null,
              },
            ],
          },
        ],
      },
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/tmp/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Grant access to its folder first');
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a path that already has a live ledger row', async () => {
    const { deps, insert } = makeDeps({
      getByPath: () =>
        Promise.resolve({
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'feature',
          createdAt: '2026-08-26T00:00:00.000Z',
          createdBy: 'user',
          id: 'existing',
          path: '/repo/wt',
          repoCommonDir: '/repo/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: null,
        }),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result).toEqual({
      error: 'BrainStrike already manages the worktree at "/repo/wt".',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts
```

Expected: `Failed to resolve import "../../assistant-server/worktree-adopt"`.

- [ ] **Step 3: Add the params contract**

In `packages/types/src/worktree.ts`, after `WorktreeCreateParams`:

```ts
/**
 * Record an EXISTING on-disk worktree in the ledger (spec §10 "Add as root" /
 * the Mode-chip picker's adoption path). Adoption is what gives an externally
 * created worktree — Claude Code's, Codex's, Cursor's, or one the agent made
 * in a shell — the durable id a thread checkout binds to.
 */
export interface WorktreeAdoptParams {
  readonly createdBy: ManagedWorktreeCreator;
  /** Absolute path of the worktree, as the inventory reports it (realpath'd). */
  readonly path: string;
  /** Present ⇒ a durable timeline row is written for this operation. */
  readonly runId?: string;
  readonly threadId?: string;
}
```

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/src/assistant-server/worktree-adopt.ts`:

```ts
/**
 * Adoption, per-checkout status, and shell reconciliation for managed
 * worktrees (BST-1392, spec §6.4, §10).
 *
 * Split out of `worktree-service.ts`, which sits at the 1000-line Biome
 * ceiling. These three operations share one discipline: they only ever act on
 * a worktree the LIVE GIT INVENTORY already reports, so a caller-supplied path
 * can never reach git or the ledger on its own authority.
 */
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { createLogger } from '@brainstrike/logging';
import type {
  GitInventory,
  GitResult,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeCheckoutStatus,
  WorktreeDescriptor,
  WorktreeSettings,
} from '@brainstrike/types';
import { uuidv7 } from 'uuidv7';
import {
  describeFailure,
  type GitCommandRunner,
  invokeGitHookFree,
  parsePorcelainV2Z,
} from './git-service';
import type { WorktreeLedger } from './worktree-ledger';

const logger = createLogger('WorktreeAdopt');

const GIT_DEFAULT_TIMEOUT_MS = 30_000;

export interface WorktreeAdoptDeps {
  readonly ledger: Pick<WorktreeLedger, 'getByPath' | 'insert' | 'listActive'>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  readonly resolveInventory: () => Promise<GitInventory>;
  readonly resolveRootPaths: () => Promise<readonly { readonly id: string; readonly path: string }[]>;
  readonly run: GitCommandRunner;
}

interface LocatedWorktree {
  readonly descriptor: WorktreeDescriptor;
  readonly repoCommonDir: string;
}

function locate(inventory: GitInventory, target: string): LocatedWorktree | null {
  for (const repository of inventory.repositories) {
    for (const descriptor of repository.worktrees) {
      if (descriptor.path === target) {
        return { descriptor, repoCommonDir: repository.identity.gitCommonDir };
      }
    }
  }
  return null;
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * A worktree may be adopted only when the app can actually REACH it: inside a
 * granted workspace root, or under the managed directory. `resolveUsability`
 * treats "has a ledger row" as authorization, so adopting an unreachable path
 * would mint a row that reads `usable: true` while every operation on it would
 * fail. Refuse loudly and name the remedy instead.
 */
async function assertReachable(
  deps: WorktreeAdoptDeps,
  descriptor: WorktreeDescriptor
): Promise<GitResult<null>> {
  if (descriptor.containment !== 'outside-roots') {
    return { ok: true, value: null };
  }
  const settings = await deps.readSettings();
  try {
    const managed = await fsPromises.realpath(settings.managedDirectory);
    if (isWithin(managed, descriptor.path)) {
      return { ok: true, value: null };
    }
  } catch (error) {
    logger.debug('managed directory could not be resolved during adoption', { error });
  }
  return {
    error: `The worktree at "${descriptor.path}" is outside every open folder. Grant access to its folder first, then adopt it.`,
    ok: false,
  };
}

export async function adoptWorktree(
  deps: WorktreeAdoptDeps,
  params: WorktreeAdoptParams
): Promise<GitResult<ManagedWorktreeRow>> {
  const inventory = await deps.resolveInventory();
  const located = locate(inventory, params.path);
  if (!located) {
    return {
      error: `No worktree at "${params.path}" is visible in the workspace inventory, so it cannot be adopted.`,
      ok: false,
    };
  }
  const { descriptor, repoCommonDir } = located;
  if (descriptor.prunableReason !== null) {
    return {
      error: `The worktree at "${params.path}" is prunable (${descriptor.prunableReason}) and cannot be adopted.`,
      ok: false,
    };
  }
  if (descriptor.trust === 'unvalidated') {
    return {
      error:
        descriptor.trustReason ??
        `The worktree at "${params.path}" could not be verified against its own .git.`,
      ok: false,
    };
  }
  const reachable = await assertReachable(deps, descriptor);
  if (!reachable.ok) {
    return reachable;
  }
  const existing = await deps.ledger.getByPath(descriptor.path);
  if (existing !== null && existing.archivedAt === null) {
    return { error: `BrainStrike already manages the worktree at "${descriptor.path}".`, ok: false };
  }
  const headRun = await invokeGitHookFree(
    (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) =>
      deps.run({ args, cwd: descriptor.path, timeoutMs }),
    ['rev-parse', 'HEAD']
  );
  if (headRun.exitCode !== 0) {
    return { error: describeFailure(headRun), ok: false };
  }
  const row: ManagedWorktreeRow = {
    archivedAt: null,
    archiveSnapshotRef: null,
    // The worktree existed before BrainStrike knew about it, so there is no
    // creation base to record. HEAD-at-adoption is the honest reference point:
    // "unpushed" then means "committed here since we started managing it".
    baseRef: headRun.stdout.trim(),
    branch: descriptor.branch,
    createdAt: new Date().toISOString(),
    createdBy: params.createdBy,
    id: uuidv7(),
    path: descriptor.path,
    repoCommonDir,
    runId: params.runId ?? null,
    setupOutput: null,
    setupReason: null,
    // Adoption never runs setup: the worktree already exists and the user did
    // not ask for a repository script to run (BST-1455 owns consent).
    setupStatus: 'none',
    threadId: params.threadId ?? null,
  };
  await deps.ledger.insert(row);
  return { ok: true, value: row };
}
```

> If `uuidv7` is not already a dependency of `apps/desktop`, use the SAME import `worktree-ledger.ts`/`worktree-service.ts` use for its ids — copy that import line verbatim rather than adding a package.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Expose it on the service**

In `worktree-service.ts`, add to the returned object (alphabetically, before `archive`) — the mutex is deliberate: adoption inserts a ledger row keyed on a path the create path also writes.

```ts
    async adopt(params: WorktreeAdoptParams): Promise<GitResult<ManagedWorktreeRow>> {
      return await serialize(async () => {
        try {
          const adopted = await adoptWorktree(
            {
              ledger,
              readSettings: deps.readSettings,
              resolveInventory: deps.resolveInventory,
              resolveRootPaths: deps.resolveRootPaths,
              run: deps.run,
            },
            params
          );
          if (adopted.ok) {
            await emitWorktreeAdoptedEvent(deps, params.runId ?? null, adopted.value);
          }
          return adopted;
        } catch (error) {
          logger.error('worktree adopt failed', { error, path: params.path });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
```

Add the emitter to `apps/desktop/src/assistant-server/worktree-run-events.ts` (it reuses the SAME `worktree.created` kind — A4).

> **No new writer and no new binding hop.** `WorktreeServiceDeps` already extends `WorktreeRunEventDeps`, whose single `recordRunEvent(runId, event)` is bound ONCE in `main.ts` at service construction with `recordDesktopAssistantRunEvent` and `getDatabase` closed over. Every emitter in this file — the three W3 ones and the two W5 adds — takes that same `deps` object and calls that same bound function. Do NOT import `recordDesktopAssistantRunEvent` into `worktree-adopt.ts` or `shell-worktree-correlation.ts`, and do NOT thread a second `getDatabase` anywhere: a second INSERT path for run events is precisely what the W3 ruling forbade.

```ts
/** `worktree.created` for a worktree BrainStrike did not create but now manages. */
export async function emitWorktreeAdoptedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow
): Promise<void> {
  await emit(deps, runId, 'worktree.created', () => ({
    detail: worktree.branch ?? 'detached HEAD',
    label: `Adopted worktree ${path.basename(worktree.path)}`,
    metadata: {
      branch: worktree.branch,
      path: worktree.path,
      via: 'adopt',
      worktreeId: worktree.id,
    },
    status: 'info',
  }));
}
```

…and add `via: 'app'` to the metadata of the existing `emitWorktreeCreateEvents` `worktree.created` payload so the vocabulary is total from the first commit.

- [ ] **Step 7: Take it across the bridge**

`apps/desktop/src/platform/desktop-ipc-channels.ts`, inside the `worktrees` block (alphabetical):

```ts
  worktrees: {
    adopt: 'worktrees:adopt',
    archive: 'worktrees:archive',
    checkoutStatus: 'worktrees:checkoutStatus',
    create: 'worktrees:create',
```

`apps/desktop/src/worktrees-ipc-handlers.ts` — add the handler slot and its narrowing validator:

```ts
export interface WorktreesIpcHandlers {
  readonly adopt: (payload: unknown) => Promise<GitResult<ManagedWorktreeRow>>;
  readonly archive: (payload: unknown) => Promise<GitResult<WorktreeArchiveResult>>;
```

```ts
function validateAdopt(payload: unknown): GitResult<WorktreeAdoptParams> {
  if (
    !(
      isRecord(payload) &&
      nonEmptyString(payload['path']) &&
      path.isAbsolute(payload['path'] as string)
    ) ||
    (payload['createdBy'] !== 'agent' && payload['createdBy'] !== 'user')
  ) {
    return {
      error: 'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.',
      ok: false,
    };
  }
  const runId = payload['runId'];
  const threadId = payload['threadId'];
  return {
    ok: true,
    value: {
      createdBy: payload['createdBy'],
      path: payload['path'] as string,
      ...(nonEmptyString(runId) ? { runId } : {}),
      ...(nonEmptyString(threadId) ? { threadId } : {}),
    },
  };
}
```

Wire it in the handler factory beside `create`, `ipc-worktrees.ts` registers the channel, `preload.ts` exposes `adopt`, and `packages/app-shell/src/worktrees/worktrees-bridge.ts` grows the method plus its pin entry:

```ts
export interface WorktreesBridge {
  adopt: (params: WorktreeAdoptParams) => Promise<GitResult<ManagedWorktreeRow>>;
  archive: (params: {
```

```ts
const WORKTREES_BRIDGE_REQUIRED_METHOD_SET = {
  adopt: true,
  archive: true,
  checkoutStatus: true,
  create: true,
  createBranchHere: true,
  createContext: true,
  getSettings: true,
  list: true,
  listManagedPaths: true,
  restore: true,
  setSettings: true,
} as const satisfies Record<keyof WorktreesBridge, true>;
```

(`checkoutStatus` lands in Task 3; add both entries now so the exact-set pin is edited once.)

- [ ] **Step 8: Replace the picker's placeholder refusal**

In `packages/app-shell/src/hooks/use-worktree-mode.ts`, `onSelectExisting` currently toasts *"Adopting one is coming with the Worktree Map."* for a row with no `worktreeId`. Replace that branch with real adoption:

```ts
  const onSelectExisting = useCallback(
    (option: WorkspaceBarWorktreeOption): void => {
      if (!bridge) {
        return;
      }
      setPending(true);
      void Promise.resolve(addRootDirectoryByPath?.(option.path))
        .then(async (mounted) => {
          if (!mounted) {
            throw new Error(`The worktree at ${option.path} could not be mounted.`);
          }
          if (option.worktreeId) {
            return option.worktreeId;
          }
          // Not managed yet: adopt it so the thread checkout has a durable id
          // to bind to. A refusal surfaces verbatim — never a silent skip.
          const adopted = await bridge.adopt({ createdBy: 'user', path: option.path });
          if (!adopted.ok) {
            throw new Error(adopted.error);
          }
          return adopted.value.id;
        })
        .then((worktreeId) =>
          args.onSelectWorktree({ branch: option.branch, path: option.path, worktreeId })
        )
        .then(async () => {
          setPickerOpen(false);
          await refreshList();
        })
        .catch((error: unknown) => {
          const message = errorMessage(error);
          logger.error('could not switch to the selected worktree', { error, path: option.path });
          toastFailure('Could not use that worktree', message);
        })
        .finally(() => {
          setPending(false);
        });
    },
    [addRootDirectoryByPath, args.onSelectWorktree, bridge, refreshList]
  );
```

Pin it with a falsifying test in `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`:

```ts
  it('adopts an unmanaged worktree before binding the thread, and binds the returned id', async () => {
    adoptMock.mockResolvedValue({
      ok: true,
      value: { id: 'adopted-1', path: '/repo/.claude/worktrees/x' },
    });
    listMock.mockResolvedValue({
      ok: true,
      value: [entry({ id: null, managed: false, name: 'x', path: '/repo/.claude/worktrees/x' })],
    });

    const { result } = renderHook(() => useWorktreeMode(args));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    act(() => {
      result.current?.picker.onSelect(result.current.picker.options[0] as never);
    });

    await waitFor(() => expect(adoptMock).toHaveBeenCalledTimes(1));
    expect(adoptMock).toHaveBeenCalledWith({
      createdBy: 'user',
      path: '/repo/.claude/worktrees/x',
    });
    expect(args.onSelectWorktree).toHaveBeenCalledTimes(1);
    expect(args.onSelectWorktree).toHaveBeenCalledWith({
      branch: 'feature',
      path: '/repo/.claude/worktrees/x',
      worktreeId: 'adopted-1',
    });
    // Falsifier: binding must not have gone through any sibling bridge call.
    expect(createMock).not.toHaveBeenCalled();
    expect(restoreMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it('surfaces an adoption refusal verbatim and never binds the thread', async () => {
    adoptMock.mockResolvedValue({ error: 'Grant access to its folder first, then adopt it.', ok: false });
    listMock.mockResolvedValue({
      ok: true,
      value: [entry({ id: null, managed: false, name: 'x', path: '/tmp/x' })],
    });

    const { result } = renderHook(() => useWorktreeMode(args));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    act(() => {
      result.current?.picker.onSelect(result.current.picker.options[0] as never);
    });

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      description: 'Grant access to its folder first, then adopt it.',
      title: 'Could not use that worktree',
      variant: 'destructive',
    });
    expect(args.onSelectWorktree).not.toHaveBeenCalled();
  });
```

- [ ] **Step 9: Run the affected lanes**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/use-worktree-mode.test.ts src/worktrees/__tests__
```

Expected: green. The preload contract test fails first if `preload.ts` or the channel block missed a key — fix the omission, never the assertion.

- [ ] **Step 10: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-adopt.ts apps/desktop/src/assistant-server/worktree-service.ts apps/desktop/src/assistant-server/worktree-run-events.ts apps/desktop/src/worktrees-ipc-handlers.ts apps/desktop/src/preload.ts packages/app-shell/src/worktrees/worktrees-bridge.ts packages/app-shell/src/hooks/use-worktree-mode.ts packages/types/src/worktree.ts
git add -A
git commit -m "feat(BST-1392): adopt an existing worktree into the managed ledger

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `worktrees:checkoutStatus` — dirty and ahead/behind, lazily

**Files:**
- Modify: `packages/types/src/worktree.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-adopt.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/worktrees-ipc-handlers.ts`, `apps/desktop/src/ipc-worktrees.ts`, `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts` (the hand-written `worktrees?: { … }` declaration — see Task 2's Files note)
- Modify: `packages/app-shell/src/worktrees/worktrees-bridge.ts`
- Modify: `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/worktree-adopt.integration.test.ts`

**Interfaces:**
- Produces, exported from `@brainstrike/types`:
```ts
/**
 * One checkout's working-tree and upstream state, read on demand (spec §10's
 * dirty / ahead-behind glyphs). Deliberately NOT part of `WorktreeListEntry`:
 * `list()` is called on every picker open and every Map refresh, and folding N
 * `git status` subprocesses into it would make an orientation surface expensive.
 */
export interface WorktreeCheckoutStatus {
  /** Commits ahead of upstream, or null when the branch has no upstream. */
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly clean: boolean;
  readonly path: string;
  readonly upstream: string | null;
}
```
- Produces on `WorktreeService` and `WorktreesBridge`: `checkoutStatus(params: { readonly path: string }): Promise<GitResult<WorktreeCheckoutStatus>>`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`:

```ts
describe('readCheckoutStatus', () => {
  it('parses ahead/behind and cleanliness from one porcelain-v2 read', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: ['# branch.head feature', '# branch.upstream origin/feature', '# branch.ab +2 -1', ''].join(
        '\0'
      ),
    }));
    const deps = {
      ledger: { getByPath: vi.fn(), insert: vi.fn(), listActive: vi.fn() } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run,
    };

    const result = await readCheckoutStatus(deps, { path: '/repo/wt' });

    expect(result).toEqual({
      ok: true,
      value: {
        ahead: 2,
        behind: 1,
        clean: true,
        path: '/repo/wt',
        upstream: 'origin/feature',
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ cwd: '/repo/wt' });
  });

  it('refuses a path the inventory does not report', async () => {
    const run = vi.fn();
    const deps = {
      ledger: { getByPath: vi.fn(), insert: vi.fn(), listActive: vi.fn() } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run,
    };

    const result = await readCheckoutStatus(deps, { path: '/etc' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('not visible in the workspace inventory');
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts -t readCheckoutStatus
```

Expected: `readCheckoutStatus is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `apps/desktop/src/assistant-server/worktree-adopt.ts`:

```ts
/**
 * The working-tree + upstream state of ONE checkout. The path must be a
 * worktree the live inventory reports — the same authority `adoptWorktree`
 * uses — so a caller-supplied path can never make git run somewhere arbitrary.
 *
 * Parsing reuses the production `parsePorcelainV2Z`; a second parser for the
 * same format would be a second source of truth for what "clean" means.
 */
export async function readCheckoutStatus(
  deps: WorktreeAdoptDeps,
  params: { readonly path: string }
): Promise<GitResult<WorktreeCheckoutStatus>> {
  const inventory = await deps.resolveInventory();
  if (!locate(inventory, params.path)) {
    return {
      error: `The path "${params.path}" is not visible in the workspace inventory, so its status cannot be read.`,
      ok: false,
    };
  }
  const statusRun = await invokeGitHookFree(
    (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) => deps.run({ args, cwd: params.path, timeoutMs }),
    ['status', '--porcelain=v2', '--branch', '-z']
  );
  if (statusRun.exitCode !== 0) {
    return { error: describeFailure(statusRun), ok: false };
  }
  const parsed = parsePorcelainV2Z(statusRun.stdout);
  return {
    ok: true,
    value: {
      ahead: parsed.ahead,
      behind: parsed.behind,
      clean: parsed.clean,
      path: params.path,
      upstream: parsed.upstream,
    },
  };
}
```

Expose it on the service (NOT inside the mutex — it is a read and must not queue behind a long create):

```ts
    async checkoutStatus(params: {
      readonly path: string;
    }): Promise<GitResult<WorktreeCheckoutStatus>> {
      try {
        return await readCheckoutStatus(
          {
            ledger,
            readSettings: deps.readSettings,
            resolveInventory: deps.resolveInventory,
            resolveRootPaths: deps.resolveRootPaths,
            run: deps.run,
          },
          params
        );
      } catch (error) {
        logger.error('worktree checkout status failed', { error, path: params.path });
        return { error: toErrorMessage(error), ok: false };
      }
    },
```

IPC narrowing in `worktrees-ipc-handlers.ts`:

```ts
function validateCheckoutStatus(payload: unknown): GitResult<{ readonly path: string }> {
  if (!(isRecord(payload) && nonEmptyString(payload['path']) && path.isAbsolute(payload['path']))) {
    return { error: 'worktrees:checkoutStatus requires { path: <absolute path> }.', ok: false };
  }
  return { ok: true, value: { path: payload['path'] } };
}
```

…plus the handler, the `ipc-worktrees.ts` registration, the `preload.ts` exposure, and the bridge method (the exact-set pin already lists `checkoutStatus` from Task 2 Step 7).

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
```

Expected: 7 passed in the adopt file; the preload contract green.

- [ ] **Step 5: Prove it against real git**

Create `apps/desktop/src/__tests__/assistant-server/worktree-adopt.integration.test.ts`:

```ts
/**
 * Real-git lane for adoption + checkout status. Uses the same temp-repo
 * fixtures the worktree-archive integration lane uses; nothing is mocked
 * below the `GitCommandRunner`.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { adoptWorktree, readCheckoutStatus } from '../../assistant-server/worktree-adopt';

const exec = promisify(execFile);
const created: string[] = [];

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await exec('git', [...args], { cwd });
}

async function freshRepo(): Promise<string> {
  const dir = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bst-w5-')));
  created.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await fsPromises.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => fsPromises.rm(dir, { force: true, recursive: true })));
});

describe('worktree adoption over real git', () => {
  it('adopts an externally created worktree and then reports its status', async () => {
    const repo = await freshRepo();
    const worktreePath = path.join(repo, 'external-wt');
    await git(repo, 'worktree', 'add', '-b', 'external', worktreePath);
    const commonDir = await fsPromises.realpath(path.join(repo, '.git'));

    const rows: unknown[] = [];
    const deps = {
      ledger: {
        getByPath: () => Promise.resolve(null),
        insert: (row: unknown) => {
          rows.push(row);
          return Promise.resolve(row);
        },
        listActive: () => Promise.resolve([]),
      } as never,
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: true,
          managedDirectory: path.join(repo, 'managed'),
          setupCommand: null,
        }),
      resolveInventory: () =>
        Promise.resolve({
          errors: [],
          repositories: [
            {
              identity: { gitCommonDir: commonDir, repositoryRoot: repo },
              worktrees: [
                {
                  branch: 'external',
                  containment: ['root-1'] as readonly string[],
                  current: false,
                  detached: false,
                  head: 'HEAD',
                  lockedReason: null,
                  name: 'external-wt',
                  path: worktreePath,
                  provenance: 'scanned' as const,
                  prunableReason: null,
                  trust: 'validated' as const,
                  trustReason: null,
                },
              ],
            },
          ],
        }),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: repo }]),
      run: async ({ args, cwd }: { readonly args: readonly string[]; readonly cwd: string }) => {
        const { stdout, stderr } = await exec('git', [...args], { cwd });
        return { exitCode: 0, signal: null, stderr, stdout };
      },
    };

    const adopted = await adoptWorktree(deps, { createdBy: 'user', path: worktreePath });
    expect(adopted.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(adopted.ok && adopted.value.baseRef).toMatch(/^[0-9a-f]{40}$/u);
    expect(adopted.ok && adopted.value.repoCommonDir).toBe(commonDir);

    await fsPromises.writeFile(path.join(worktreePath, 'dirty.txt'), 'x');
    const status = await readCheckoutStatus(deps, { path: worktreePath });
    expect(status.ok).toBe(true);
    expect(status.ok && status.value.clean).toBe(false);
    expect(status.ok && status.value.upstream).toBeNull();
  });
});
```

```bash
pnpm --filter @brainstrike/desktop test:integration -- src/__tests__/assistant-server/worktree-adopt.integration.test.ts
```

Expected: 1 passed.

- [ ] **Step 6: Gate and commit**

```bash
pnpm run type-check
pnpm run lint:eslint
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-adopt.ts apps/desktop/src/worktrees-ipc-handlers.ts apps/desktop/src/preload.ts packages/app-shell/src/worktrees/worktrees-bridge.ts packages/types/src/worktree.ts
pnpm dlx ultracite check apps/desktop/src/assistant-server/worktree-adopt.ts apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1392): lazy per-checkout status for the worktree map

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---
# Layer 2 — The Worktree Map workspace app

**Branch:** `seandearnaley/bst-1392-w5-worktree-map` (stacked on Layer 1)

```bash
gh stack add seandearnaley/bst-1392-w5-worktree-map
```

Runs in PARALLEL with Layer 3 in an isolated worktree; file sets are disjoint (see the DAG).

- [ ] **Layer 2 Step 0: Confirm #2655's persisted opt-in map is swept by factory reset**

This layer reads `worktreeRootIndexingOptInById`, the persisted map PR #2655 (BST-1453) added. Any persistent store must be wired into factory reset (`docs/agents/platform-contracts.md`). To be honest about attribution: the live-store gap below is NOT a #2655 regression — `background-indexing-preferences-store` was never in factory reset's re-default list (`git log -S "background-indexing-preferences-store" -- packages/app-state/src/factory-reset.ts` is empty); #2655 merely raised the severity by adding per-root opt-ins to the persisted blob. Re-verify at execution time — *before* building on it:

```bash
git show origin/integration/workspace-checkout-awareness:packages/app-state/src/stores/background-indexing-preferences-store.ts \
  | rg -n "worktreeRootIndexingOptInById" 
rg -n "resetBackgroundIndexingPreferences|electronAPI\?\.storage|localStorage.clear" packages/app-state/src/factory-reset.ts
```

Three facts must hold, and only the third is in doubt:

1. **Store-level `reset()` clears it** — confirmed present at the time of writing: `reset:` sets both `worktreeRootIndexingByAdapterRootId` and `worktreeRootIndexingOptInById` back to `DEFAULT_STATE`.
2. **It is persisted and therefore purgeable** — confirmed: `partialize` includes `worktreeRootIndexingOptInById`, and `factory-reset.ts` clears BOTH backing stores (`localStorage.clear()` for web and `electronAPI.storage.clear()` for desktop, where this store actually lives).
3. **The LIVE in-memory store is reset on a reset-without-reload** — **this is the gap to check.** `factory-reset.ts` explicitly re-defaults a list of live stores (permission policy, notification preferences, hook trust, workspace instructions, …) precisely because the web path does not reload, and `useBackgroundIndexingPreferencesStore` is **not** in that list (plan review confirmed against `949f11331`: exactly 13 `reset*ToDefaults()` helpers are called, this store in none of them). If it is still absent, a factory reset leaves a stale per-root opt-in in memory and the Map renders "Indexing enabled" for a root the user just wiped.

**If (3) is missing, fix it in-band here** — this layer is its first real consumer, so it is not unrelated debt: export a `resetBackgroundIndexingPreferencesStoreToDefaults()` (matching the neighbours' `reset<X>StoreToDefaults` naming, e.g. `resetHookTrustStoreToDefaults`) beside the existing helpers, call it from `factory-reset.ts` inside the same `try/catch` shape as its neighbours, add a case to `packages/app-state/src/__tests__/factory-reset-*.test.ts` asserting the opt-in map is empty afterwards, and record the store in the FACTORY RESET CONTRACT list in `docs/agents/platform-contracts.md`. If it is already wired, note that in the Task 14 docs pass and move on.

---

### Task 4: The pure Map model

**Files:**
- Create: `packages/app-shell/src/worktree-map/worktree-map-model.ts`
- Create: `packages/app-shell/src/worktree-map/__tests__/worktree-map-model.test.ts`

**Interfaces:**
- Consumes: `WorktreeListEntry` (Layer 1), `ForgePrCacheLookup` + `forgePrCacheKey` (`@brainstrike/types`, landed W4), `AssistantMemoryThread` metadata.
- Produces:
```ts
export interface WorktreeMapThread {
  readonly running: boolean;
  readonly threadId: string;
  readonly title: string;
  /** `AssistantMemoryThread.updatedAt` is a `Date` end-to-end — see the note below. */
  readonly updatedAt: Date | null;
}
export interface WorktreeMapCardModel {
  readonly branchLabel: string;
  readonly createdAt: string | null;
  readonly disabledReason: string | null;
  readonly entry: WorktreeListEntry;
  readonly indexing: 'excluded' | 'included' | 'not-a-root';
  readonly lastActivityLabel: string | null;
  readonly provenanceLabel: string;
  readonly pullRequest: ForgePrCacheEntry | null;
  readonly thread: WorktreeMapThread | null;
}
export interface WorktreeMapRepositoryModel {
  readonly cards: readonly WorktreeMapCardModel[];
  readonly repoCommonDir: string;
  readonly repositoryName: string;
  readonly repositoryRoot: string;
}
export function buildWorktreeMap(input: {
  readonly entries: readonly WorktreeListEntry[];
  readonly formatActivity?: (at: Date) => string;
  readonly indexingOptInByRootId: Readonly<Record<string, true>>;
  readonly now?: Date;
  readonly prCache: ForgePrCacheLookup;
  readonly runningThreadIds: ReadonlySet<string>;
  readonly threads: readonly AssistantMemoryThread[];
}): readonly WorktreeMapRepositoryModel[];
export function describeWorktreeProvenance(entry: WorktreeListEntry): string;
export function formatWorktreeActivity(at: Date, now: Date): string;
```

> **`updatedAt` is a `Date`, not a string.** `AssistantMemoryThread.updatedAt` is declared `readonly updatedAt: Date` (`packages/assistant-data/src/assistant-memory-repository.ts:62`), and `assistant-thread-store.ts`'s `serializeThread` re-wraps it with `new Date(...)` on every load and merge — `mergeThread` even sorts on `.getTime()`. The model therefore types it as `Date` and formats it; it never sees, stores or renders an ISO string. `createdAt` on `WorktreeListEntry` IS a string, because it crosses the IPC boundary from the ledger as JSON — the two are deliberately different types and the model parses the latter exactly once, at the boundary.
>
> **The card renders a RELATIVE label, not a timestamp.** `formatWorktreeActivity` produces "just now" / "12 minutes ago" / "3 days ago" via `Intl.RelativeTimeFormat`, falling back to `Intl.DateTimeFormat` beyond a week. A raw ISO string in a UI card is machine output, not a human-readable "last activity". Both `now` and `formatActivity` are injectable so the unit lane is deterministic without faking timers.

- [ ] **Step 1: Write the failing test**

Create `packages/app-shell/src/worktree-map/__tests__/worktree-map-model.test.ts`:

```ts
import type { AssistantMemoryThread, AssistantThreadMetadata } from '@brainstrike/assistant-data';
import type { WorktreeListEntry } from '@brainstrike/types';
import { forgePrCacheKey } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import {
  buildWorktreeMap,
  describeWorktreeProvenance,
  formatWorktreeActivity,
} from '../worktree-map-model';

const NOW = new Date('2026-08-26T12:00:00.000Z');

// A REAL AssistantMemoryThread — every required field, correctly typed. The
// `as never` shortcut this file used to take made the Date-vs-string defect in
// `updatedAt` invisible: a cast fixture agrees with whatever the model claims.
function thread(overrides: {
  readonly id: string;
  readonly metadata?: AssistantThreadMetadata;
  readonly title?: string;
  readonly updatedAt?: Date;
}): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    id: overrides.id,
    resourceId: 'brainstrike:workspace',
    title: overrides.title ?? 'Untitled thread',
    updatedAt: overrides.updatedAt ?? NOW,
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
}

function entry(overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  return {
    branch: 'main',
    containment: ['root-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: 'brainstrike',
    path: '/repo',
    primary: true,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: '/repo/.git',
    repositoryRoot: '/repo',
    rootId: 'root-1',
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: false,
    ...overrides,
  };
}

describe('buildWorktreeMap', () => {
  it('groups by repository and puts the primary checkout first in the lane', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ id: 'wt-1', managed: true, name: 'bright-fox', path: '/wt', primary: false }),
        entry(),
      ],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model).toHaveLength(1);
    expect(model[0]?.repositoryName).toBe('repo');
    expect(model[0]?.cards.map((card) => card.entry.path)).toEqual(['/repo', '/wt']);
  });

  it('keeps repositories separate and sorts them by display name', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ repoCommonDir: '/z/.git', repositoryRoot: '/z' }),
        entry({ repoCommonDir: '/a/.git', repositoryRoot: '/a' }),
      ],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model.map((repository) => repository.repositoryName)).toEqual(['a', 'z']);
  });

  it('joins the PR cache on (repoCommonDir, branch), not on repositoryRoot', () => {
    const pr = {
      branch: 'bs/bright-fox',
      checksRollup: 'passing' as const,
      isDraft: false,
      number: 2574,
      repoCommonDir: '/repo/.git',
      state: 'open' as const,
      url: 'https://github.com/acme/repo/pull/2574',
    };
    const model = buildWorktreeMap({
      entries: [entry({ branch: 'bs/bright-fox', path: '/wt', primary: false })],
      indexingOptInByRootId: {},
      prCache: new Map([[forgePrCacheKey('/repo/.git', 'bs/bright-fox'), pr]]),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.pullRequest).toEqual(pr);
  });

  it('attaches the thread whose checkout metadata names the worktree, with its run state', () => {
    const updatedAt = new Date('2026-08-26T10:00:00.000Z');
    const model = buildWorktreeMap({
      entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(['thread-1']),
      threads: [
        thread({
          id: 'thread-1',
          metadata: { checkoutMode: 'worktree', checkoutWorktreeId: 'wt-1' },
          title: 'Fix the parser',
          updatedAt,
        }),
        thread({
          id: 'thread-2',
          metadata: { checkoutMode: 'local' },
          title: 'Something else',
          updatedAt: new Date('2026-08-26T11:00:00.000Z'),
        }),
      ],
    });

    expect(model[0]?.cards[0]?.thread).toEqual({
      running: true,
      threadId: 'thread-1',
      title: 'Fix the parser',
      updatedAt,
    });
    // A `Date`, not a string — this is the assertion the old `as never` fixture
    // could not make, because a cast fixture agrees with any claim.
    expect(model[0]?.cards[0]?.thread?.updatedAt).toBeInstanceOf(Date);
    expect(model[0]?.cards[0]?.lastActivityLabel).toBe('Active 2 hours ago');
  });

  it('ignores a thread whose metadata names the worktree but has left worktree mode', () => {
    const model = buildWorktreeMap({
      entries: [entry({ id: 'wt-1', managed: true, path: '/wt', primary: false })],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [
        thread({
          id: 'thread-1',
          // Legacy shape: the worktree id survives a hand-off to Local.
          metadata: { checkoutMode: 'local', checkoutWorktreeId: 'wt-1' },
          title: 'Handed off already',
        }),
      ],
    });

    expect(model[0]?.cards[0]?.thread).toBeNull();
  });

  it('falls back to the ledger creation stamp, and renders nothing when neither fact exists', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ createdAt: '2026-08-20T00:00:00.000Z', id: 'a', path: '/a', primary: false }),
        entry({ createdAt: null, path: '/b', primary: false }),
      ],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.lastActivityLabel).toBe('Created 6 days ago');
    expect(model[0]?.cards[1]?.lastActivityLabel).toBeNull();
  });

  it('states an unparseable ledger stamp instead of rendering "Invalid Date"', () => {
    const model = buildWorktreeMap({
      entries: [entry({ createdAt: 'not-a-date', id: 'a', path: '/a', primary: false })],
      indexingOptInByRootId: {},
      now: NOW,
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.lastActivityLabel).toBe('Created at an unreadable time');
  });

  it('reports indexing state only for a mounted root, never guessing for an unmounted worktree', () => {
    const model = buildWorktreeMap({
      entries: [
        entry({ id: 'a', managed: true, path: '/a', primary: false, rootId: 'root-a' }),
        entry({ id: 'b', managed: true, path: '/b', primary: false, rootId: 'root-b' }),
        entry({ id: 'c', managed: true, path: '/c', primary: false, rootId: null }),
      ],
      indexingOptInByRootId: { 'root-a': true },
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards.map((card) => card.indexing)).toEqual([
      'included',
      'excluded',
      'not-a-root',
    ]);
  });

  it('carries the disabled reason through untouched', () => {
    const model = buildWorktreeMap({
      entries: [entry({ disabledReason: 'Locked: rebase in progress', usable: false })],
      indexingOptInByRootId: {},
      prCache: new Map(),
      runningThreadIds: new Set(),
      threads: [],
    });

    expect(model[0]?.cards[0]?.disabledReason).toBe('Locked: rebase in progress');
  });
});

describe('describeWorktreeProvenance', () => {
  // (corrected at execution: fixture defaulted primary: true against its own
  // precedence rule; never executed as written — counts corrected) `primary:
  // false` overrides the fixture default so each case exercises the
  // externalTool/managed branch it names, not the primary short-circuit — see
  // the dedicated precedence test below for that.
  it.each([
    [{ externalTool: 'claude-code' as const, managed: false, primary: false }, 'Claude Code'],
    [{ externalTool: 'codex' as const, managed: false, primary: false }, 'Codex'],
    [{ externalTool: 'cursor' as const, managed: false, primary: false }, 'Cursor'],
    [{ externalTool: null, managed: true, primary: false }, 'Managed'],
    [{ externalTool: null, managed: false, primary: false }, 'External'],
  ])('labels %o as %s', (overrides, expected) => {
    expect(describeWorktreeProvenance(entry(overrides))).toBe(expected);
  });

  it('labels the primary checkout as the primary, ahead of every other label', () => {
    expect(describeWorktreeProvenance(entry({ managed: true, primary: true }))).toBe(
      'Primary checkout'
    );
  });

  it('labels the primary checkout as the primary even when an externalTool is set', () => {
    expect(
      describeWorktreeProvenance(entry({ externalTool: 'claude-code', primary: true }))
    ).toBe('Primary checkout');
  });

  it('labels a ledger row missing on disk as agent-reported', () => {
    expect(
      describeWorktreeProvenance(
        entry({ managed: true, primary: false, provenance: 'agent-reported' })
      )
    ).toBe('Missing on disk');
  });
});

describe('formatWorktreeActivity', () => {
  it.each([
    [new Date('2026-08-26T11:59:30.000Z'), 'just now'],
    [new Date('2026-08-26T11:48:00.000Z'), '12 minutes ago'],
    [new Date('2026-08-26T09:00:00.000Z'), '3 hours ago'],
    [new Date('2026-08-23T12:00:00.000Z'), '3 days ago'],
  ])('renders %s as %s', (at, expected) => {
    expect(formatWorktreeActivity(at, NOW)).toBe(expected);
  });

  it('falls back to an absolute date beyond a week', () => {
    // Relative phrasing stops being informative once it is "last month"; the
    // absolute date is shorter to read and unambiguous.
    expect(formatWorktreeActivity(new Date('2026-06-01T12:00:00.000Z'), NOW)).toMatch(
      /Jun(?:e)? 1/u
    );
  });

  it('never renders "Invalid Date" for an unreadable input', () => {
    expect(formatWorktreeActivity(new Date(Number.NaN), NOW)).toBe('at an unreadable time');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/app-shell vitest run src/worktree-map/__tests__/worktree-map-model.test.ts
```

Expected: `Failed to resolve import "../worktree-map-model"`.

- [ ] **Step 3: Write the model**

Create `packages/app-shell/src/worktree-map/worktree-map-model.ts`:

```ts
/**
 * The Worktree Map's ONE projection (spec §10). Pure: no bridge, no DB, no
 * React. Everything it needs is already produced by a landed surface —
 * `worktrees.list()`, `useForgePrCache`, the assistant thread store,
 * `useActiveAssistantThreadIds`, and BST-1453's worktree indexing opt-ins — so
 * the Map introduces no new source of truth for any fact it renders.
 */
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { ForgePrCacheEntry, WorktreeListEntry } from '@brainstrike/types';
import { forgePrCacheKey } from '@brainstrike/types';

export type ForgePrCacheLookup = ReadonlyMap<string, ForgePrCacheEntry>;

export interface WorktreeMapThread {
  readonly running: boolean;
  readonly threadId: string;
  readonly title: string;
  /**
   * `AssistantMemoryThread.updatedAt` is a `Date` (assistant-memory-repository
   * declares it so, and `assistant-thread-store`'s `serializeThread` re-wraps it
   * with `new Date(...)` on every load and merge). Typed as `Date` here so the
   * model can never silently render an object as "[object Object]".
   */
  readonly updatedAt: Date | null;
}

export interface WorktreeMapCardModel {
  readonly branchLabel: string;
  readonly createdAt: string | null;
  /** Non-null exactly when the entry is not usable — passed through verbatim. */
  readonly disabledReason: string | null;
  readonly entry: WorktreeListEntry;
  /**
   * `not-a-root` means the worktree is not mounted as a workspace root, so
   * there is no indexing preference to report. It is NOT "excluded": inventing
   * an answer for an unmounted path would be a silent fallback.
   */
  readonly indexing: 'excluded' | 'included' | 'not-a-root';
  readonly lastActivityLabel: string | null;
  readonly provenanceLabel: string;
  readonly pullRequest: ForgePrCacheEntry | null;
  readonly thread: WorktreeMapThread | null;
}

export interface WorktreeMapRepositoryModel {
  readonly cards: readonly WorktreeMapCardModel[];
  readonly repoCommonDir: string;
  readonly repositoryName: string;
  readonly repositoryRoot: string;
}

function displayNameFor(absolutePath: string): string {
  return absolutePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? absolutePath;
}

export function describeWorktreeProvenance(entry: WorktreeListEntry): string {
  if (entry.primary) {
    return 'Primary checkout';
  }
  if (entry.provenance === 'agent-reported') {
    return 'Missing on disk';
  }
  if (entry.externalTool === 'claude-code') {
    return 'Claude Code';
  }
  if (entry.externalTool === 'codex') {
    return 'Codex';
  }
  if (entry.externalTool === 'cursor') {
    return 'Cursor';
  }
  return entry.managed ? 'Managed' : 'External';
}

function branchLabelFor(entry: WorktreeListEntry): string {
  if (entry.branch) {
    return entry.branch;
  }
  return entry.detached ? 'detached HEAD' : 'no branch';
}

function indexingFor(
  entry: WorktreeListEntry,
  optInByRootId: Readonly<Record<string, true>>
): WorktreeMapCardModel['indexing'] {
  if (entry.rootId === null) {
    return 'not-a-root';
  }
  return optInByRootId[entry.rootId] === true ? 'included' : 'excluded';
}

function threadFor(
  entry: WorktreeListEntry,
  threadsByWorktreeId: ReadonlyMap<string, AssistantMemoryThread>,
  runningThreadIds: ReadonlySet<string>
): WorktreeMapThread | null {
  if (entry.id === null) {
    return null;
  }
  const thread = threadsByWorktreeId.get(entry.id);
  if (!thread) {
    return null;
  }
  return {
    running: runningThreadIds.has(thread.id),
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt instanceof Date ? thread.updatedAt : null,
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Beyond a week, "last month" stops being informative — show the date instead. */
const RELATIVE_LIMIT_MS = 7 * DAY_MS;
const UNREADABLE_TIME = 'at an unreadable time';

/**
 * A human "last activity", not a machine timestamp. `Intl` does the localizing,
 * so a non-English locale reads correctly without a translation table here.
 * `now` is a parameter rather than `Date.now()` so the unit lane is
 * deterministic without faking timers.
 */
export function formatWorktreeActivity(at: Date, now: Date): string {
  const elapsed = now.getTime() - at.getTime();
  if (!Number.isFinite(elapsed)) {
    // An unparseable stamp says so. `Intl` would render "Invalid Date", which
    // reads like a bug report in the middle of a card.
    return UNREADABLE_TIME;
  }
  if (Math.abs(elapsed) > RELATIVE_LIMIT_MS) {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);
  }
  if (elapsed < MINUTE_MS) {
    return 'just now';
  }
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (elapsed < HOUR_MS) {
    return relative.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
  }
  if (elapsed < DAY_MS) {
    return relative.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  }
  return relative.format(-Math.floor(elapsed / DAY_MS), 'day');
}

function lastActivityLabelFor(
  thread: WorktreeMapThread | null,
  createdAt: string | null,
  now: Date,
  format: (at: Date) => string
): string | null {
  if (thread?.updatedAt) {
    return `Active ${format(thread.updatedAt)}`;
  }
  if (createdAt) {
    // `WorktreeListEntry.createdAt` IS a string: it crosses the IPC boundary
    // from the ledger as JSON. Parsed exactly once, here, and a bad value is
    // stated rather than rendered as "Invalid Date".
    const parsed = new Date(createdAt);
    return `Created ${Number.isNaN(parsed.getTime()) ? UNREADABLE_TIME : format(parsed)}`;
  }
  // Neither fact exists. Rendering "unknown" would be noise; rendering an
  // invented timestamp would be a lie. Render nothing.
  return null;
}

/**
 * Threads keyed by the worktree they are checked out into. A thread contributes
 * only when it is IN worktree mode: `checkoutWorktreeId` survives a hand-off to
 * Local in some legacy rows, and reading it without the mode check would show a
 * worktree as occupied by a thread that has already left it.
 */
function indexThreadsByWorktreeId(
  threads: readonly AssistantMemoryThread[]
): ReadonlyMap<string, AssistantMemoryThread> {
  const byWorktreeId = new Map<string, AssistantMemoryThread>();
  for (const thread of threads) {
    const metadata = thread.metadata;
    if (metadata?.checkoutMode !== 'worktree') {
      continue;
    }
    const worktreeId = metadata.checkoutWorktreeId;
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      continue;
    }
    byWorktreeId.set(worktreeId, thread);
  }
  return byWorktreeId;
}

export function buildWorktreeMap(input: {
  readonly entries: readonly WorktreeListEntry[];
  /** Injectable for the unit lane; defaults to {@link formatWorktreeActivity}. */
  readonly formatActivity?: (at: Date) => string;
  readonly indexingOptInByRootId: Readonly<Record<string, true>>;
  readonly now?: Date;
  readonly prCache: ForgePrCacheLookup;
  readonly runningThreadIds: ReadonlySet<string>;
  readonly threads: readonly AssistantMemoryThread[];
}): readonly WorktreeMapRepositoryModel[] {
  const threadsByWorktreeId = indexThreadsByWorktreeId(input.threads);
  const now = input.now ?? new Date();
  const format = input.formatActivity ?? ((at: Date) => formatWorktreeActivity(at, now));
  const byRepository = new Map<string, { cards: WorktreeMapCardModel[]; entry: WorktreeListEntry }>();

  for (const entry of input.entries) {
    const thread = threadFor(entry, threadsByWorktreeId, input.runningThreadIds);
    const card: WorktreeMapCardModel = {
      branchLabel: branchLabelFor(entry),
      createdAt: entry.createdAt,
      disabledReason: entry.disabledReason,
      entry,
      indexing: indexingFor(entry, input.indexingOptInByRootId),
      lastActivityLabel: lastActivityLabelFor(thread, entry.createdAt, now, format),
      provenanceLabel: describeWorktreeProvenance(entry),
      pullRequest: entry.branch
        ? (input.prCache.get(forgePrCacheKey(entry.repoCommonDir, entry.branch)) ?? null)
        : null,
      thread,
    };
    const group = byRepository.get(entry.repoCommonDir);
    if (group) {
      group.cards.push(card);
      continue;
    }
    byRepository.set(entry.repoCommonDir, { cards: [card], entry });
  }

  return [...byRepository.values()]
    .map(({ cards, entry }) => ({
      // Primary first, then by name — the lane reads left-to-right as "the
      // user's clone, then the isolated copies" (spec §10).
      cards: [...cards].sort((left, right) => {
        if (left.entry.primary !== right.entry.primary) {
          return left.entry.primary ? -1 : 1;
        }
        return left.entry.name.localeCompare(right.entry.name);
      }),
      repoCommonDir: entry.repoCommonDir,
      repositoryName: displayNameFor(entry.repositoryRoot),
      repositoryRoot: entry.repositoryRoot,
    }))
    .sort((left, right) => left.repositoryName.localeCompare(right.repositoryName));
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @brainstrike/app-shell vitest run src/worktree-map/__tests__/worktree-map-model.test.ts
```

Expected: 23 passed (9 `buildWorktreeMap`, 8 `describeWorktreeProvenance` cases, 6 `formatWorktreeActivity`). (corrected at execution: the original "19 passed" text was never checked against the test file it describes — the file as written defines 23 cases, and 5 of the original 22 failed outright because the fixture's `primary: true` default beat the `describeWorktreeProvenance` it.each block's externalTool/managed cases; see the it.each block above for the fix and the added precedence-pinning case.)

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/worktree-map
git add packages/app-shell/src/worktree-map
git commit -m "feat(BST-1392): the pure Worktree Map projection

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `useWorktreeMap` — one composition hook, no new data source

**Files:**
- Create: `packages/app-shell/src/worktree-map/use-worktree-checkout-status.ts`
- Create: `packages/app-shell/src/worktree-map/use-worktree-map.ts`
- Create: `packages/app-shell/src/worktree-map/__tests__/use-worktree-map.test.ts` (`.ts`, not `.tsx` — the suite renders no JSX)

**Interfaces — SETTLED, and the RED test in Step 1 is written against exactly this signature:**
```ts
export type WorktreeCheckoutStatusState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: WorktreeCheckoutStatus };
export function useWorktreeCheckoutStatuses(input: {
  readonly bridge: WorktreesBridge | null;
  readonly paths: readonly string[];
  readonly refreshNonce: number;
}): ReadonlyMap<string, WorktreeCheckoutStatusState>;

export interface UseWorktreeMapInput {
  readonly database: DbHandle | null;
  readonly resourceId: string;
  readonly runningThreadIds: ReadonlySet<string>;
}
export interface WorktreeMapState {
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly repositories: readonly WorktreeMapRepositoryModel[];
  readonly statusByPath: ReadonlyMap<string, WorktreeCheckoutStatusState>;
}
export function useWorktreeMap(input: UseWorktreeMapInput): WorktreeMapState;
```

> **Why the hook takes those three and resolves nothing itself.** `ChangesSurface` — the closest precedent — is a zero-prop component that resolves its context internally, and `WorktreeMapSurface` follows it exactly (Task 6). But the DATA hook is where every join happens, so keeping `database` / `resourceId` / `runningThreadIds` as explicit inputs is what makes the unit lane able to drive it without a `PGliteProvider`, a live `useActiveAssistantThreadIds` and a real resource. The surface resolves the three from context (`usePGliteDatabase()`, `WORKSPACE_MEMORY_RESOURCE_ID`, `useActiveAssistantThreadIds`) and hands them down — prop-free component, explicitly-fed hook.

- [ ] **Step 1: Write the failing test**

Create `packages/app-shell/src/worktree-map/__tests__/use-worktree-map.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
const checkoutStatusMock = vi.fn();
const adoptMock = vi.fn();
const archiveMock = vi.fn();

vi.mock('../../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    adopt: adoptMock,
    archive: archiveMock,
    checkoutStatus: checkoutStatusMock,
    list: listMock,
  }),
}));

const useForgePrCacheMock = vi.fn(() => ({ byRepoBranch: new Map(), error: null, loading: false }));
vi.mock('../../hooks/use-forge-pr-cache', () => ({
  useForgePrCache: () => useForgePrCacheMock(),
}));

// The two stores the hook reads. Both are mocked as SELECTOR-CALLING functions
// (that is how zustand hooks are consumed), so the hook's real selectors run
// against a controlled state object rather than being stubbed out wholesale.
let storeThreads: readonly unknown[] = [];
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  useAssistantThreadStore: (
    selector: (state: { threadsByResourceId: Record<string, readonly unknown[]> }) => unknown
  ) => selector({ threadsByResourceId: { 'brainstrike:workspace': storeThreads } }),
}));

let indexingOptIn: Record<string, true> = {};
vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', () => ({
  useBackgroundIndexingPreferencesStore: (
    selector: (state: { worktreeRootIndexingOptInById: Record<string, true> }) => unknown
  ) => selector({ worktreeRootIndexingOptInById: indexingOptIn }),
}));

let invalidationNonce = 0;
vi.mock('../../changes/changes-live-refresh-store', () => ({
  useChangesLiveRefreshStore: (selector: (state: { anyInvalidationNonce: number }) => unknown) =>
    selector({ anyInvalidationNonce: invalidationNonce }),
}));
vi.mock('../../changes/use-changes-live-refresh', () => ({
  useChangesLiveRefreshSubscription: () => undefined,
}));

import { useWorktreeMap, type UseWorktreeMapInput } from '../use-worktree-map';

const INPUT: UseWorktreeMapInput = {
  database: null,
  resourceId: 'brainstrike:workspace',
  runningThreadIds: new Set<string>(),
};

function entry(overrides: Record<string, unknown> = {}) {
  return {
    branch: 'main',
    containment: ['root-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: 'repo',
    path: '/repo',
    primary: true,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: '/repo/.git',
    repositoryRoot: '/repo',
    rootId: 'root-1',
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: false,
    ...overrides,
  };
}

describe('useWorktreeMap', () => {
  beforeEach(() => {
    invalidationNonce = 0;
    listMock.mockReset().mockResolvedValue({ ok: true, value: [entry()] });
    checkoutStatusMock
      .mockReset()
      .mockResolvedValue({
        ok: true,
        value: { ahead: 0, behind: 0, clean: true, path: '/repo', upstream: 'origin/main' },
      });
    adoptMock.mockReset();
    archiveMock.mockReset();
  });

  it('loads the list once on mount and projects it into repository lanes', async () => {
    const { result } = renderHook(() => useWorktreeMap(INPUT));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listMock).toHaveBeenCalledTimes(1);
    // Falsifier: the Map must not mutate anything to render itself.
    expect(adoptMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
    expect(result.current.repositories).toHaveLength(1);
    expect(result.current.repositories[0]?.cards).toHaveLength(1);
  });

  it('reads each visible checkout status exactly once per invalidation generation', async () => {
    const { rerender, result } = renderHook(() => useWorktreeMap(INPUT));
    await waitFor(() => expect(result.current.statusByPath.get('/repo')?.kind).toBe('ready'));
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);
    expect(checkoutStatusMock).toHaveBeenCalledWith({ path: '/repo' });

    rerender();
    expect(checkoutStatusMock).toHaveBeenCalledTimes(1);

    act(() => {
      invalidationNonce = 1;
    });
    rerender();
    await waitFor(() => expect(checkoutStatusMock).toHaveBeenCalledTimes(2));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('reports a list failure as an error and never as an empty map', async () => {
    listMock.mockResolvedValue({ error: 'The worktree service is not available.', ok: false });

    const { result } = renderHook(() => useWorktreeMap(INPUT));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('The worktree service is not available.');
    expect(result.current.repositories).toEqual([]);
  });

  it('reports a per-card status failure as a stated reason, not as a clean checkout', async () => {
    checkoutStatusMock.mockResolvedValue({ error: 'fatal: not a git repository', ok: false });

    const { result } = renderHook(() => useWorktreeMap(INPUT));

    await waitFor(() => expect(result.current.statusByPath.get('/repo')?.kind).toBe('error'));
    expect(result.current.statusByPath.get('/repo')).toEqual({
      kind: 'error',
      message: 'fatal: not a git repository',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/app-shell vitest run src/worktree-map/__tests__/use-worktree-map.test.ts
```

Expected: `Failed to resolve import "../use-worktree-map"`.

- [ ] **Step 3: Write the lazy status reader**

Create `packages/app-shell/src/worktree-map/use-worktree-checkout-status.ts`:

```ts
/**
 * Per-card `git status` for the Worktree Map, read LAZILY and at most once per
 * (path, invalidation generation).
 *
 * Deliberately not folded into `worktrees.list()`: that call also backs the
 * Mode chip's picker and runs on every refresh, and N status subprocesses
 * behind an orientation surface is the cost this seam exists to avoid (A3).
 * Concurrency is bounded so a workspace with twenty worktrees does not fork
 * twenty gits at once.
 */
import { createLogger } from '@brainstrike/logging';
import type { WorktreeCheckoutStatus } from '@brainstrike/types';
import { useEffect, useState } from 'react';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

const logger = createLogger('WorktreeCheckoutStatus');

/** Simultaneous `git status` reads. Four keeps a large workspace responsive
 * without saturating a laptop's process table. */
const MAX_CONCURRENT_STATUS_READS = 4;

export type WorktreeCheckoutStatusState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: WorktreeCheckoutStatus };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readInBatches(
  bridge: WorktreesBridge,
  paths: readonly string[],
  onResult: (path: string, state: WorktreeCheckoutStatusState) => void,
  isCancelled: () => boolean
): Promise<void> {
  const queue = [...paths];
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_STATUS_READS, queue.length) },
    async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (isCancelled()) {
          return;
        }
        const path = next;
        try {
          const result = await bridge.checkoutStatus({ path });
          if (isCancelled()) {
            return;
          }
          onResult(
            path,
            result.ok ? { kind: 'ready', value: result.value } : { kind: 'error', message: result.error }
          );
        } catch (error) {
          logger.warn('worktree checkout status threw', { error, path });
          if (!isCancelled()) {
            onResult(path, { kind: 'error', message: errorMessage(error) });
          }
        }
      }
    }
  );
  await Promise.all(workers);
}

export function useWorktreeCheckoutStatuses(input: {
  readonly bridge: WorktreesBridge | null;
  readonly paths: readonly string[];
  readonly refreshNonce: number;
}): ReadonlyMap<string, WorktreeCheckoutStatusState> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, WorktreeCheckoutStatusState>>(
    new Map()
  );
  // Serialize the paths so the effect keys on CONTENT, not on array identity:
  // the list is rebuilt on every refresh and would otherwise re-read forever.
  // JSON rather than a delimiter join: a POSIX path may contain any byte except
  // NUL, so no separator character is safe, and a raw NUL in a source file is
  // banned in this repo.
  const pathKey = JSON.stringify(input.paths);
  const { bridge, refreshNonce } = input;

  useEffect(() => {
    // Round-trips a value THIS hook just serialized, so the cast is total.
    const paths = JSON.parse(pathKey) as readonly string[];
    if (!bridge || paths.length === 0) {
      setStatuses(new Map());
      return;
    }
    let cancelled = false;
    setStatuses(new Map(paths.map((path) => [path, { kind: 'loading' } as const])));
    void readInBatches(
      bridge,
      paths,
      (path, state) => {
        setStatuses((previous) => {
          const next = new Map(previous);
          next.set(path, state);
          return next;
        });
      },
      () => cancelled
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, pathKey, refreshNonce]);

  return statuses;
}
```

- [ ] **Step 4: Write the composition hook**

Create `packages/app-shell/src/worktree-map/use-worktree-map.ts`:

```ts
/**
 * Everything the Worktree Map renders, composed from surfaces that already
 * exist. The ONLY new read is `worktrees.list()`; the PR pills, thread
 * occupancy, run state and indexing opt-ins all come from live queries and
 * stores the app already maintains for other surfaces, so the Map can never
 * disagree with the composer chip or the thread list about the same fact.
 *
 * Refresh is EVENT-TRIGGERED, exactly like W4's forge reads: the shared
 * `changes:invalidated` nonce (`anyInvalidationNonce`) is the only repeat
 * trigger, plus an explicit user refresh. No timer.
 */
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { type AssistantMemoryThread, useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeListEntry } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from '../changes/use-changes-live-refresh';
import { useForgePrCache } from '../hooks/use-forge-pr-cache';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import {
  type WorktreeCheckoutStatusState,
  useWorktreeCheckoutStatuses,
} from './use-worktree-checkout-status';
import { buildWorktreeMap, type WorktreeMapRepositoryModel } from './worktree-map-model';

const logger = createLogger('WorktreeMap');

/**
 * Module scope, ABOVE the hook: a zustand selector that allocated `[]` inline
 * would return a fresh array identity on every render and re-run every
 * downstream `useMemo` forever (the identity-churn class recorded in
 * `project_file_tree_perf`). Declared before its only reader so the reference
 * is initialized when the hook first runs, never in a TDZ window.
 */
const EMPTY_THREADS: readonly AssistantMemoryThread[] = [];

export interface UseWorktreeMapInput {
  /** `null` until the PGlite handle resolves; the PR-cache query stays disabled. */
  readonly database: DbHandle | null;
  readonly resourceId: string;
  readonly runningThreadIds: ReadonlySet<string>;
}

export interface WorktreeMapState {
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly repositories: readonly WorktreeMapRepositoryModel[];
  readonly statusByPath: ReadonlyMap<string, WorktreeCheckoutStatusState>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWorktreeMap(input: UseWorktreeMapInput): WorktreeMapState {
  const bridge = useMemo(() => resolveWorktreesBridge(), []);
  const [entries, setEntries] = useState<readonly WorktreeListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualNonce, setManualNonce] = useState(0);

  // Hold the shared dual-source live-refresh owner while the Map is mounted;
  // no Git-scope registration, because the Map is repository-wide.
  useChangesLiveRefreshSubscription();
  const invalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  const refreshNonce = invalidationNonce + manualNonce;

  const load = useCallback(
    async (isCancelled?: () => boolean): Promise<void> => {
      if (!bridge) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const result = await bridge.list();
        if (isCancelled?.()) {
          return;
        }
        if (result.ok) {
          setEntries(result.value);
          setError(null);
          return;
        }
        // A failed list is a stated failure, never an empty Map: an empty Map
        // is the honest rendering of "no worktrees", a different fact.
        setEntries([]);
        setError(result.error);
      } catch (caught) {
        logger.error('worktree map list threw', { error: caught });
        if (!isCancelled?.()) {
          setEntries([]);
          setError(errorMessage(caught));
        }
      } finally {
        if (!isCancelled?.()) {
          setLoading(false);
        }
      }
    },
    [bridge]
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, refreshNonce]);

  const prCache = useForgePrCache({ database: input.database, enabled: bridge !== null });
  const threads = useAssistantThreadStore(
    (state) => state.threadsByResourceId[input.resourceId] ?? EMPTY_THREADS
  );
  const indexingOptInByRootId = useBackgroundIndexingPreferencesStore(
    (state) => state.worktreeRootIndexingOptInById
  );

  const repositories = useMemo(
    () =>
      buildWorktreeMap({
        entries,
        indexingOptInByRootId,
        prCache: prCache.byRepoBranch,
        runningThreadIds: input.runningThreadIds,
        threads,
      }),
    [entries, indexingOptInByRootId, prCache.byRepoBranch, input.runningThreadIds, threads]
  );

  const paths = useMemo(
    () =>
      repositories.flatMap((repository) =>
        repository.cards
          // A ghost row has no directory to run git in; asking would produce a
          // confusing "not a git repository" beside a card that already says
          // "missing on disk".
          .filter((card) => card.entry.provenance !== 'agent-reported')
          .map((card) => card.entry.path)
      ),
    [repositories]
  );
  const statusByPath = useWorktreeCheckoutStatuses({ bridge, paths, refreshNonce });

  const refresh = useCallback(async (): Promise<void> => {
    setManualNonce((previous) => previous + 1);
    await load();
  }, [load]);

  return {
    error: error ?? (prCache.error ? `Pull-request cache unavailable: ${prCache.error.message}` : null),
    loading,
    refresh,
    repositories,
    statusByPath,
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
pnpm --filter @brainstrike/app-shell vitest run src/worktree-map/__tests__/use-worktree-map.test.ts
```

Expected: 4 passed. The suite already targets the settled `UseWorktreeMapInput` signature and already carries the thread-store and background-indexing-store mocks, so nothing about it changes between RED and GREEN — there is no follow-up edit to make here.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/worktree-map
git add packages/app-shell/src/worktree-map
git commit -m "feat(BST-1392): compose the Worktree Map from landed surfaces

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The Map surface and the checkout-intent seam

**Files:**
- Create: `packages/app-shell/src/stores/worktree-checkout-intent-store.ts`
- Create: `packages/app-shell/src/worktree-map/worktree-map-card.tsx`
- Create: `packages/app-shell/src/worktree-map/worktree-map-surface.tsx`
- Create: `packages/app-shell/src/worktree-map/index.ts`
- Create: `packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx`
- Create: `packages/app-shell/src/__tests__/worktree-checkout-intent-store.test.ts`
- Modify: `packages/app-shell/src/hooks/use-workspace-bar-mode.ts`

**Interfaces:**
```ts
export interface WorktreeCheckoutIntent {
  readonly branch: string | null;
  readonly path: string;
  readonly threadId: string;
  /** `null` ⇒ hand off to Local instead of binding a worktree. */
  readonly worktreeId: string | null;
}
export interface WorktreeCheckoutIntentState {
  readonly consume: (threadId: string) => WorktreeCheckoutIntent | null;
  readonly pending: WorktreeCheckoutIntent | null;
  readonly publish: (intent: WorktreeCheckoutIntent) => void;
}
export const useWorktreeCheckoutIntentStore: UseBoundStore<StoreApi<WorktreeCheckoutIntentState>>;
```

- [ ] **Step 1: Write the failing store test**

Create `packages/app-shell/src/__tests__/worktree-checkout-intent-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';

const INTENT = {
  branch: 'bs/bright-fox',
  path: '/wt',
  threadId: 'thread-1',
  worktreeId: 'wt-1',
} as const;

describe('useWorktreeCheckoutIntentStore', () => {
  beforeEach(() => {
    useWorktreeCheckoutIntentStore.setState({ pending: null });
  });

  it('hands the intent to the matching thread exactly once', () => {
    useWorktreeCheckoutIntentStore.getState().publish(INTENT);

    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-1')).toEqual(INTENT);
    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-1')).toBeNull();
    expect(useWorktreeCheckoutIntentStore.getState().pending).toBeNull();
  });

  it('does not hand a thread another thread’s intent, and does not clear it', () => {
    useWorktreeCheckoutIntentStore.getState().publish(INTENT);

    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-2')).toBeNull();
    expect(useWorktreeCheckoutIntentStore.getState().pending).toEqual(INTENT);
  });

  it('replaces an unconsumed intent rather than queueing', () => {
    useWorktreeCheckoutIntentStore.getState().publish(INTENT);
    useWorktreeCheckoutIntentStore.getState().publish({ ...INTENT, path: '/wt2', worktreeId: 'wt-2' });

    expect(useWorktreeCheckoutIntentStore.getState().consume('thread-1')?.worktreeId).toBe('wt-2');
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the store**

```bash
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/worktree-checkout-intent-store.test.ts
```

Create `packages/app-shell/src/stores/worktree-checkout-intent-store.ts`:

```ts
/**
 * One-shot cross-surface checkout intent (BST-1392, spec §10 "New thread here"
 * / "Hand off").
 *
 * The Worktree Map lives in the workspace tab strip; the checkout WRITER
 * (`useThreadCheckout`, mounted by `useWorkspaceBar`) lives in the composer.
 * They are different component trees, so the Map publishes an intent and the
 * composer consumes it — the `changes-navigation-store` idiom. This store is
 * NOT a second source of truth: it holds a request for at most one tick and
 * clears it the moment the real writer takes it.
 *
 * `worktreeId: null` means "hand off to Local", so both directions travel the
 * same seam and neither surface grows a second write path.
 */
import { create } from 'zustand';

export interface WorktreeCheckoutIntent {
  readonly branch: string | null;
  readonly path: string;
  readonly threadId: string;
  readonly worktreeId: string | null;
}

export interface WorktreeCheckoutIntentState {
  /** Returns and CLEARS the intent when it targets `threadId`; else null. */
  readonly consume: (threadId: string) => WorktreeCheckoutIntent | null;
  readonly pending: WorktreeCheckoutIntent | null;
  readonly publish: (intent: WorktreeCheckoutIntent) => void;
}

export const useWorktreeCheckoutIntentStore = create<WorktreeCheckoutIntentState>((set, get) => ({
  consume: (threadId) => {
    const { pending } = get();
    if (!pending || pending.threadId !== threadId) {
      return null;
    }
    // Clear BEFORE the caller starts its async write: a re-render between the
    // read and the write must not see the same intent twice.
    set({ pending: null });
    return pending;
  },
  pending: null,
  publish: (intent) => {
    set({ pending: intent });
  },
}));
```

- [ ] **Step 3: Consume the intent in the composer**

Modify `packages/app-shell/src/hooks/use-workspace-bar-mode.ts` — it already receives `onHandOffToLocal` and `onSelectWorktree` and is only 88 lines, so it is the right host (`use-workspace-bar.ts` sits at the 1000-line ceiling). Add:

```ts
import { useEffect, useRef } from 'react';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
```

```ts
  // Apply a Worktree Map intent to the SELECTED thread, once. `consume` clears
  // the entry, so a re-render cannot re-apply it; a failure surfaces through
  // the same toast path the chip uses and the intent is not retried.
  const pendingIntent = useWorktreeCheckoutIntentStore((state) => state.pending);
  const consumeIntent = useWorktreeCheckoutIntentStore((state) => state.consume);
  const applyingRef = useRef(false);
  useEffect(() => {
    const threadId = selectedThread?.id;
    if (!threadId || pendingIntent?.threadId !== threadId || applyingRef.current) {
      return;
    }
    const intent = consumeIntent(threadId);
    if (!intent) {
      return;
    }
    applyingRef.current = true;
    const applied = intent.worktreeId
      ? onSelectWorktree({
          branch: intent.branch,
          path: intent.path,
          worktreeId: intent.worktreeId,
        })
      : onHandOffToLocal();
    void applied
      .catch((error: unknown) => {
        logger.error('worktree map checkout intent failed', { error, threadId });
      })
      .finally(() => {
        applyingRef.current = false;
      });
  }, [consumeIntent, onHandOffToLocal, onSelectWorktree, pendingIntent, selectedThread?.id]);
```

Pin it in `packages/app-shell/src/__tests__/use-workspace-bar-mode.test.tsx` with a falsifying pair:

```ts
  it('binds the published worktree to the selected thread exactly once', async () => {
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-1',
      worktreeId: 'wt-1',
    });

    const { rerender } = renderHook(() => useWorkspaceBarMode(args));
    await waitFor(() => expect(onSelectWorktree).toHaveBeenCalledTimes(1));
    expect(onSelectWorktree).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/wt',
      worktreeId: 'wt-1',
    });
    expect(onHandOffToLocal).not.toHaveBeenCalled();

    rerender();
    expect(onSelectWorktree).toHaveBeenCalledTimes(1);
  });

  it('hands off to Local when the intent carries a null worktree id', async () => {
    useWorktreeCheckoutIntentStore
      .getState()
      .publish({ branch: null, path: '/repo', threadId: 'thread-1', worktreeId: null });

    renderHook(() => useWorkspaceBarMode(args));

    await waitFor(() => expect(onHandOffToLocal).toHaveBeenCalledTimes(1));
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('ignores an intent published for a different thread', async () => {
    useWorktreeCheckoutIntentStore
      .getState()
      .publish({ branch: null, path: '/wt', threadId: 'other', worktreeId: 'wt-9' });

    renderHook(() => useWorkspaceBarMode(args));

    await Promise.resolve();
    expect(onSelectWorktree).not.toHaveBeenCalled();
    expect(onHandOffToLocal).not.toHaveBeenCalled();
    expect(useWorktreeCheckoutIntentStore.getState().pending).not.toBeNull();
  });
```

- [ ] **Step 4: Write the failing surface test**

Create `packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx`.

> **`WorktreeMapSurface` takes NO props.** It is the `ChangesSurface` shape exactly (`packages/app-shell/src/changes/ui/changes-surface.tsx:83` — `export function ChangesSurface(): ReactElement` with zero parameters, resolving everything from context): the desktop wrapper renders `<WorktreeMapSurface />` and the surface resolves the database, the resource id, the running-thread set and the thread-store actions itself. So this suite mocks the CONTEXT the surface reads — there is no `props` object anywhere, and every mocked callback gets its own `vi.fn()` so a swapped wiring fails.

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useWorktreeMapMock = vi.fn();
vi.mock('../use-worktree-map', () => ({ useWorktreeMap: () => useWorktreeMapMock() }));

const publishMock = vi.fn();
vi.mock('../../stores/worktree-checkout-intent-store', () => ({
  useWorktreeCheckoutIntentStore: Object.assign(
    (selector: (state: { publish: unknown }) => unknown) => selector({ publish: publishMock }),
    { getState: () => ({ publish: publishMock }) }
  ),
}));

// The context the surface resolves for itself. Distinct mocks per action so a
// test can prove WHICH one ran.
const createThreadMock = vi.fn();
const selectThreadMock = vi.fn();
// (corrected at execution: the surface code below derives `repository` from
// `database` via `createPgliteAssistantThreadRepository` — `createThread`
// takes `(repository, resourceId, title?)`, never a bare `resourceId`, and
// this plan's original surface code called it with one argument, which does
// not compile (`tsc`: "Expected 2-3 arguments, but got 1") — a real defect,
// not a test-fixture one. `mockDatabase` is a controllable sentinel so one
// test can prove the new guard fires when it's null, and
// `createPgliteAssistantThreadRepositoryMock` returns a DISTINCT sentinel so
// `createThread`'s call assertion stays falsifiable for BOTH arguments.
// `vi.hoisted` — not a plain top-level `const` — because these are
// referenced from a `vi.mock` factory declared further down, and only
// `vi.hoisted`-declared bindings are guaranteed initialized before a hoisted
// `vi.mock` factory can run.)
const { SENTINEL_DATABASE, SENTINEL_REPOSITORY, createPgliteAssistantThreadRepositoryMock } =
  vi.hoisted(() => {
    const sentinelDatabase = { kind: 'sentinel-database' } as const;
    const sentinelRepository = { kind: 'sentinel-repository' } as const;
    return {
      createPgliteAssistantThreadRepositoryMock: vi.fn(() => sentinelRepository),
      SENTINEL_DATABASE: sentinelDatabase,
      SENTINEL_REPOSITORY: sentinelRepository,
    };
  });
let mockDatabase: unknown = SENTINEL_DATABASE;
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => mockDatabase }));
vi.mock('../../use-active-assistant-thread-ids', () => ({
  useActiveAssistantThreadIds: () => ({ error: null, loading: false, threadIds: new Set() }),
}));
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  createPgliteAssistantThreadRepository: createPgliteAssistantThreadRepositoryMock,
  useAssistantThreadStore: (
    selector: (state: {
      createThread: typeof createThreadMock;
      selectThread: typeof selectThreadMock;
      threadsByResourceId: Record<string, readonly unknown[]>;
    }) => unknown
  ) =>
    selector({
      createThread: createThreadMock,
      selectThread: selectThreadMock,
      threadsByResourceId: {},
    }),
}));

const setIndexingMock = vi.fn();
vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', () => ({
  useBackgroundIndexingPreferencesStore: (
    selector: (state: { setWorktreeRootIndexingEnabled: typeof setIndexingMock }) => unknown
  ) => selector({ setWorktreeRootIndexingEnabled: setIndexingMock }),
}));

const showItemInFolderMock = vi.fn();
const openExternalMock = vi.fn();
vi.mock('../../platform-bridge', () => ({
  resolvePlatformBridge: () => ({
    openExternal: openExternalMock,
    showItemInFolder: showItemInFolderMock,
  }),
}));

const adoptMock = vi.fn();
const archiveMock = vi.fn();
vi.mock('../../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({ adopt: adoptMock, archive: archiveMock }),
}));

const addRootDirectoryByPathMock = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectoryByPath: addRootDirectoryByPathMock }),
}));

import { WorktreeMapSurface } from '../worktree-map-surface';

function card(overrides: Record<string, unknown> = {}) {
  return {
    branchLabel: 'bs/bright-fox',
    createdAt: null,
    disabledReason: null,
    entry: {
      branch: 'bs/bright-fox',
      id: 'wt-1',
      managed: true,
      name: 'bright-fox',
      path: '/wt',
      primary: false,
      rootId: 'root-1',
      usable: true,
    },
    indexing: 'excluded',
    lastActivityLabel: 'Created 6 days ago',
    provenanceLabel: 'Managed',
    pullRequest: null,
    thread: null,
    ...overrides,
  };
}

const BASE_STATE = {
  error: null,
  loading: false,
  refresh: vi.fn(),
  repositories: [
    {
      cards: [card()],
      repoCommonDir: '/repo/.git',
      repositoryName: 'brainstrike',
      repositoryRoot: '/repo',
    },
  ],
  statusByPath: new Map([['/wt', { kind: 'ready', value: { ahead: 2, behind: 0, clean: false } }]]),
};

describe('WorktreeMapSurface', () => {
  beforeEach(() => {
    for (const mock of [
      addRootDirectoryByPathMock,
      adoptMock,
      archiveMock,
      createPgliteAssistantThreadRepositoryMock,
      createThreadMock,
      openExternalMock,
      publishMock,
      selectThreadMock,
      setIndexingMock,
      showItemInFolderMock,
    ]) {
      mock.mockReset();
    }
    createPgliteAssistantThreadRepositoryMock.mockReturnValue(SENTINEL_REPOSITORY);
    mockDatabase = SENTINEL_DATABASE;
    addRootDirectoryByPathMock.mockResolvedValue({ kind: 'directory', name: 'wt' });
    adoptMock.mockResolvedValue({ ok: true, value: {} });
    archiveMock.mockResolvedValue({ ok: true, value: {} });
    createThreadMock.mockResolvedValue({ id: 'thread-9' });
    useWorktreeMapMock.mockReset().mockReturnValue(BASE_STATE);
  });

  it('renders one section per repository and one card per checkout', () => {
    render(<WorktreeMapSurface />);

    expect(screen.getByRole('heading', { name: 'brainstrike' })).toBeInTheDocument();
    expect(screen.getAllByTestId('worktree-map-card')).toHaveLength(1);
    expect(screen.getByText('bs/bright-fox')).toBeInTheDocument();
    expect(screen.getByText('Managed')).toBeInTheDocument();
  });

  it('shows dirty and ahead glyphs from the per-card status, never before it resolves', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      statusByPath: new Map([['/wt', { kind: 'loading' }]]),
    });
    const { rerender } = render(<WorktreeMapSurface />);
    expect(screen.getByText('checking…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uncommitted changes')).not.toBeInTheDocument();

    useWorktreeMapMock.mockReturnValue(BASE_STATE);
    rerender(<WorktreeMapSurface />);
    expect(screen.getByLabelText('Uncommitted changes')).toBeInTheDocument();
    expect(screen.getByLabelText('2 commits ahead of upstream')).toBeInTheDocument();
  });

  it('states a per-card status failure instead of a clean glyph', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      statusByPath: new Map([['/wt', { kind: 'error', message: 'fatal: not a git repository' }]]),
    });
    render(<WorktreeMapSurface />);

    expect(screen.getByText('status unavailable: fatal: not a git repository')).toBeInTheDocument();
  });

  it('renders an unusable card present-but-disabled with its stated reason', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              disabledReason: 'Locked: rebase in progress',
              entry: { ...card().entry, usable: false },
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    expect(screen.getByText('Locked: rebase in progress')).toBeInTheDocument();
    expect(screen.getByTestId('worktree-map-new-thread')).toBeDisabled();
  });

  it('states a list failure instead of rendering an empty map', () => {
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      error: 'The worktree service is not available in this session.',
      repositories: [],
    });
    render(<WorktreeMapSurface />);

    expect(
      screen.getByText('The worktree service is not available in this session.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No worktrees yet')).not.toBeInTheDocument();
  });

  it('shows the empty state only when the list genuinely came back empty', () => {
    useWorktreeMapMock.mockReturnValue({ ...BASE_STATE, repositories: [] });
    render(<WorktreeMapSurface />);

    expect(
      screen.getByText("No worktrees yet — create one from the composer's Mode chip.")
    ).toBeInTheDocument();
  });

  it('creates a thread, selects it, and publishes the checkout intent for THAT thread id', async () => {
    createThreadMock.mockResolvedValue({ id: 'thread-9' });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    expect(createThreadMock).toHaveBeenCalledTimes(1);
    // (corrected at execution: falsifiable for BOTH arguments —
    // `SENTINEL_REPOSITORY` proves the real repository derived from
    // `database` is what's threaded through, not `expect.anything()`
    // standing in for an unverified first argument.)
    expect(createThreadMock).toHaveBeenCalledWith(SENTINEL_REPOSITORY, 'brainstrike:workspace');
    expect(selectThreadMock).toHaveBeenCalledTimes(1);
    expect(selectThreadMock).toHaveBeenCalledWith('brainstrike:workspace', 'thread-9');
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-9',
      worktreeId: 'wt-1',
    });
    // Falsifier: the Map must not reach for any other seam to do this.
    expect(setIndexingMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('states a loud error and never calls createThread when the workspace database is not ready', async () => {
    // (corrected at execution: onNewThread's repository guard, added beside
    // the existing !worktreeId guard, must fail LOUD — a stated actionError,
    // never a silent return — and createThread must never be reached.)
    mockDatabase = null;
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText(
      'Starting a new thread is unavailable until the workspace database is ready.'
    );
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes no intent and states the failure when thread creation fails', async () => {
    createThreadMock.mockRejectedValue(new Error('database unavailable'));
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-new-thread'));

    await screen.findByText('database unavailable');
    expect(publishMock).not.toHaveBeenCalled();
    expect(selectThreadMock).not.toHaveBeenCalled();
  });

  it('toggles indexing through the durable-root setter, never the adapter-keyed one', async () => {
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByRole('button', { name: /not indexed/iu }));

    expect(setIndexingMock).toHaveBeenCalledTimes(1);
    expect(setIndexingMock).toHaveBeenCalledWith('root-1', true);
  });

  // These two pin the destructive/rooting seams so the surface cannot ship
  // with the handlers stubbed (plan-review R2): each asserts the CALL and its
  // exact argument, which no `setActionError(null)` stub can satisfy.
  it('archives through the worktrees bridge with the card worktree id and states a refusal verbatim', async () => {
    archiveMock.mockResolvedValue({ ok: false, error: 'worktree has uncommitted changes' });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /archive/iu }));

    expect(archiveMock).toHaveBeenCalledTimes(1);
    expect(archiveMock).toHaveBeenCalledWith({ worktreeId: 'wt-1' });
    await screen.findByText('Worktree not archived: worktree has uncommitted changes');
  });

  it('adds the checkout as a workspace root through the by-path seam', async () => {
    // (corrected at execution: the shared `card()` fixture's default is
    // `rootId: 'root-1'` — already a mounted root, so the card correctly
    // never offers "Add as root" for it (`entry.rootId === null` gates the
    // item below). This is the one test that exercises the unmounted case;
    // every other test keeps the shared default. Same class of defect, same
    // treatment, as Task 4's `primary: true` fixture default.)
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, rootId: null } })],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /add as root/iu }));

    expect(addRootDirectoryByPathMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).toHaveBeenCalledWith('/wt');
    // Falsifier: adding a root never archives or mutates indexing.
    expect(archiveMock).not.toHaveBeenCalled();
    expect(setIndexingMock).not.toHaveBeenCalled();
  });

  // An unmanaged card offers Adopt as its own ENABLED action (never a
  // disabled "coming soon" stub — A1/A7), and this is the FIRST real UI
  // caller of `worktrees.adopt`: Task 2 shipped the bridge method, but the
  // Mode chip picker's own planned call was unreachable and removed.
  it('adopts through the worktrees bridge with the card path, refreshes on success', async () => {
    const refreshMock = vi.fn();
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [
            card({
              disabledReason: 'Created outside BrainStrike — adopting it is coming with the Worktree Map.',
              entry: { ...card().entry, id: null, managed: false, usable: false },
              provenanceLabel: 'External',
            }),
          ],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /adopt/iu }));

    expect(adoptMock).toHaveBeenCalledTimes(1);
    expect(adoptMock).toHaveBeenCalledWith({ createdBy: 'user', path: '/wt' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // Falsifier: adopting never archives or adds a root.
    expect(archiveMock).not.toHaveBeenCalled();
    expect(addRootDirectoryByPathMock).not.toHaveBeenCalled();
  });

  it('states an adoption refusal verbatim and does not refresh', async () => {
    const refreshMock = vi.fn();
    adoptMock.mockResolvedValue({
      error: 'The worktree at "/wt" is outside every open folder. Grant access to its folder first, then adopt it.',
      ok: false,
    });
    useWorktreeMapMock.mockReturnValue({
      ...BASE_STATE,
      refresh: refreshMock,
      repositories: [
        {
          ...BASE_STATE.repositories[0],
          cards: [card({ entry: { ...card().entry, id: null, managed: false, usable: false } })],
        },
      ],
    });
    render(<WorktreeMapSurface />);

    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));
    await userEvent.click(screen.getByRole('menuitem', { name: /adopt/iu }));

    await screen.findByText(
      'Could not adopt "bright-fox": The worktree at "/wt" is outside every open folder. Grant access to its folder first, then adopt it.'
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  // TRIPWIRE (coordinator ruling, 2026-08-26). W3's A6 ruling deferred the
  // terminal-session seam to W6 and recorded "absent, not stubbed"; W5's Map
  // is exactly where a well-meaning edit would reintroduce it, because spec
  // §10 lists the action. This test states the omission as a CONTRACT so the
  // ruling cannot be quietly reversed: the item must not appear in any form —
  // enabled, disabled, or "coming soon". When W6 lands the terminal seam, this
  // test is DELETED in that PR, not weakened here.
  it('offers no "Open in Terminal" action anywhere on a card (W6 owns the seam)', async () => {
    render(<WorktreeMapSurface />);
    await userEvent.click(screen.getByTestId('worktree-map-card-actions'));

    expect(screen.queryByText(/open in terminal/iu)).not.toBeInTheDocument();
    // Also assert the DISABLED shape is absent: a disabled stub would satisfy
    // a naive queryByRole({ name, disabled: false }) check while still being
    // the exact thing the ruling forbids.
    expect(
      screen.queryByRole('menuitem', { name: /terminal/iu })
    ).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Write the card and the surface**

Create `packages/app-shell/src/worktree-map/worktree-map-card.tsx` — PURE and prop-driven, so every behavior the Step-4 suite pins is reachable without context:

```tsx
/**
 * One checkout card in the Worktree Map (spec §10). Pure: every action arrives
 * as a prop and every fact arrives on the model, so the surface owns all
 * context and this file owns only presentation.
 */
import { Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@brainstrike/ui';
import { MoreHorizontal } from 'lucide-react';
import type { ReactElement } from 'react';
import type { WorktreeCheckoutStatusState } from './use-worktree-checkout-status';
import type { WorktreeMapCardModel } from './worktree-map-model';

export interface WorktreeMapCardProps {
  readonly card: WorktreeMapCardModel;
  /** Present only for the card holding the SELECTED thread's checkout [A11]. */
  readonly onHandOffToLocal?: (() => void) | undefined;
  readonly onAddAsRoot: (card: WorktreeMapCardModel) => void;
  /** Present on every card; enabled only for `!entry.managed` (spec §10 "Add as root" / A7). */
  readonly onAdopt: (card: WorktreeMapCardModel) => void;
  readonly onArchive: (card: WorktreeMapCardModel) => void;
  readonly onNewThread: (card: WorktreeMapCardModel) => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onReveal: (path: string) => void;
  readonly onToggleIndexing: (rootId: string, enabled: boolean) => void;
  readonly status: WorktreeCheckoutStatusState | undefined;
}

function StatusGlyphs({ status }: { readonly status: WorktreeCheckoutStatusState | undefined }) {
  if (!status || status.kind === 'loading') {
    // Never a clean glyph before the read resolves: "clean" is a claim, and we
    // do not have it yet.
    return <span className="text-muted-foreground text-xs">checking…</span>;
  }
  if (status.kind === 'error') {
    return (
      <span className="text-destructive text-xs">status unavailable: {status.message}</span>
    );
  }
  const { ahead, behind, clean } = status.value;
  return (
    <span className="flex items-center gap-1 text-xs">
      {clean ? null : (
        <span aria-label="Uncommitted changes" role="img" title="Uncommitted changes">
          ●
        </span>
      )}
      {ahead ? (
        <span aria-label={`${ahead} commits ahead of upstream`} role="img">
          ↑{ahead}
        </span>
      ) : null}
      {behind ? (
        <span aria-label={`${behind} commits behind upstream`} role="img">
          ↓{behind}
        </span>
      ) : null}
    </span>
  );
}

export function WorktreeMapCard({
  card,
  onAddAsRoot,
  onAdopt,
  onArchive,
  onHandOffToLocal,
  onNewThread,
  onOpenPullRequest,
  onOpenThread,
  onReveal,
  onToggleIndexing,
  status,
}: WorktreeMapCardProps): ReactElement {
  const { entry } = card;
  const indexingEnabled = card.indexing === 'included';
  return (
    <article
      className="flex w-64 shrink-0 flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="worktree-map-card"
    >
      <header className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-sm" title={entry.path}>
          {entry.name}
        </span>
        <Badge variant="outline">{card.provenanceLabel}</Badge>
      </header>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-muted-foreground text-xs">{card.branchLabel}</span>
        <StatusGlyphs status={status} />
      </div>

      {card.pullRequest ? (
        <Button
          className="h-6 justify-start px-1 text-xs"
          onClick={() => onOpenPullRequest(card.pullRequest?.url ?? '')}
          type="button"
          variant="ghost"
        >
          #{card.pullRequest.number} {card.pullRequest.checksRollup}
        </Button>
      ) : null}

      {card.indexing === 'not-a-root' ? null : (
        <Button
          className="h-5 self-start px-1.5 text-[10px]"
          onClick={() => {
            if (entry.rootId) {
              onToggleIndexing(entry.rootId, !indexingEnabled);
            }
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {indexingEnabled ? 'Indexing enabled' : 'Not indexed'}
        </Button>
      )}

      {card.thread ? (
        <p className="truncate text-xs">
          {card.thread.running ? '● ' : ''}
          {card.thread.title}
        </p>
      ) : null}
      {card.lastActivityLabel ? (
        <p className="text-muted-foreground text-xs">{card.lastActivityLabel}</p>
      ) : null}

      {/* Present-but-disabled with the reason, never hidden (spec §13). */}
      {card.disabledReason ? (
        <p className="text-destructive text-xs">{card.disabledReason}</p>
      ) : null}

      <footer className="flex items-center gap-2">
        <Button
          data-testid="worktree-map-new-thread"
          disabled={!entry.usable}
          onClick={() => onNewThread(card)}
          size="sm"
          title={card.disabledReason ?? undefined}
          type="button"
        >
          New thread here
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Actions for ${entry.name}`}
              data-testid="worktree-map-card-actions"
              size="sm"
              type="button"
              variant="ghost"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {card.thread ? (
              <DropdownMenuItem onSelect={() => onOpenThread(card.thread?.threadId ?? '')}>
                Open thread
              </DropdownMenuItem>
            ) : null}
            {onHandOffToLocal ? (
              <DropdownMenuItem onSelect={onHandOffToLocal}>Hand off to Local</DropdownMenuItem>
            ) : null}
            {entry.rootId === null ? (
              <DropdownMenuItem onSelect={() => onAddAsRoot(card)}>Add as root</DropdownMenuItem>
            ) : null}
            {/*
              An unmanaged card is not "refused" — Adopt is its own ENABLED
              action (spec §10 "Add as root" / A7), the only surface that ever
              calls `worktrees.adopt` for real: the Mode chip's picker never
              could (every unmanaged row is `usable: false`, so its select
              button stays disabled — see A1's correction). New thread here /
              Archive… stay disabled until this card is adopted; nothing here
              is silently skipped.
            */}
            {entry.managed ? null : (
              <DropdownMenuItem onSelect={() => onAdopt(card)}>Adopt</DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onReveal(entry.path)}>Reveal</DropdownMenuItem>
            {entry.managed ? (
              <DropdownMenuItem onSelect={() => onArchive(card)}>Archive…</DropdownMenuItem>
            ) : null}
            {/*
              NO "Open in Terminal" ITEM. W3 ruling A6 defers the
              terminal-session seam to W6 and records "absent, not stubbed"; the
              Step-4 tripwire fails if this comment stops being true.
            */}
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
    </article>
  );
}
```

**Deliberate omissions from this card (coordinator ruling, 2026-08-26):**

| Omitted | Owner | Enforcement |
| --- | --- | --- |
| `Open in Terminal` — listed by spec §10, deferred by W3's A6 ruling because no terminal-session seam exists | **W6** | The absence-assertion tripwire in Step 4. A disabled stub is NOT an acceptable substitute; the item must not exist in any form until W6 lands the seam, at which point that test is deleted in the SAME PR that adds the action. |
| Any PR-mutating action (merge, close, re-run checks) | Forbidden in v1 [D5] | The PR pill is a link only; Task 14's CDT pass reports that the pill has no `button` descendant. |

Create `packages/app-shell/src/worktree-map/worktree-map-surface.tsx` — the zero-prop screen, resolving context exactly like `ChangesSurface`:

```tsx
/**
 * The Worktree Map screen (spec §10, [D11]). Zero props, like `ChangesSurface`:
 * the desktop wrapper renders `<WorktreeMapSurface />` and this component
 * resolves the database, the resource, the running-thread set and the thread
 * actions from context. Every mutation it can trigger goes through a seam that
 * already exists — the checkout-intent store, the thread store, the durable
 * indexing setter, the platform bridge — so the Map owns no state of its own.
 */
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
// (corrected at execution: `createThread` takes `(repository: AssistantThreadRepository,
// resourceId: string, title?: string)`, never a bare `resourceId` — the
// original single-argument call below did not compile. `repository` is
// derived from `database` exactly as `use-global-command-handlers.ts:29-32`
// already does for the identical problem, via the real import path
// `createPgliteAssistantThreadRepository` from `@brainstrike/assistant-data`.)
import {
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { resolvePlatformBridge } from '../platform-bridge';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';
import { useActiveAssistantThreadIds } from '../use-active-assistant-thread-ids';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
import { useWorktreeMap } from './use-worktree-map';
import { WorktreeMapCard } from './worktree-map-card';
import type { WorktreeMapCardModel } from './worktree-map-model';

const logger = createLogger('WorktreeMapSurface');

const EMPTY_STATE = "No worktrees yet — create one from the composer's Mode chip.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorktreeMapSurface(): ReactElement {
  const database = usePGliteDatabase();
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const selectThread = useAssistantThreadStore((state) => state.selectThread);
  const setWorktreeRootIndexingEnabled = useBackgroundIndexingPreferencesStore(
    (state) => state.setWorktreeRootIndexingEnabled
  );
  const publishIntent = useWorktreeCheckoutIntentStore((state) => state.publish);
  const repository = useMemo<AssistantThreadRepository | null>(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const platform = useMemo(() => resolvePlatformBridge(), []);
  const worktrees = useMemo(() => resolveWorktreesBridge(), []);
  // Desktop-only, `undefined` on web (`use-workspace-bar.ts:918` is the precedent).
  const addRootDirectoryByPath = useFileSystem().addRootDirectoryByPath;
  const { threadIds: runningThreadIds } = useActiveAssistantThreadIds({
    database,
    resourceId,
    schemaReady: Object.hasOwn(threadsByResourceId, resourceId),
  });
  const { error, loading, refresh, repositories, statusByPath } = useWorktreeMap({
    database,
    resourceId,
    runningThreadIds,
  });
  const [actionError, setActionError] = useState<string | null>(null);

  const onNewThread = useCallback(
    (card: WorktreeMapCardModel) => {
      const worktreeId = card.entry.id;
      if (!worktreeId) {
        // An unadopted row cannot be bound; the card is disabled in that state,
        // so reaching here at all is a wiring bug worth stating.
        setActionError(`"${card.entry.name}" is not a managed worktree yet.`);
        return;
      }
      if (!repository) {
        // (corrected at execution) Unlike the worktreeId guard above, "New
        // thread here" is NOT disabled while the database is still
        // resolving — this is a real, reachable, user-visible state (not
        // just a wiring bug), so it gets its own stated reason rather than a
        // silent no-op.
        setActionError(
          'Starting a new thread is unavailable until the workspace database is ready.'
        );
        return;
      }
      setActionError(null);
      void createThread(repository, resourceId)
        .then((thread) => {
          selectThread(resourceId, thread.id);
          publishIntent({
            branch: card.entry.branch,
            path: card.entry.path,
            threadId: thread.id,
            worktreeId,
          });
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not start a thread', { error: caught });
          setActionError(errorMessage(caught));
        });
    },
    [createThread, publishIntent, repository, resourceId, selectThread]
  );

  const onAddAsRoot = useCallback(
    (card: WorktreeMapCardModel) => {
      if (!addRootDirectoryByPath) {
        // The Map only registers on desktop, so a missing by-path seam is a
        // wiring bug worth stating, never a silent no-op.
        setActionError('Adding a workspace root by path is unavailable in this build.');
        return;
      }
      setActionError(null);
      addRootDirectoryByPath(card.entry.path)
        .then((handle) => {
          if (!handle) {
            setActionError(`Could not add "${card.entry.name}" as a workspace root.`);
          }
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not add a root', { error: caught, path: card.entry.path });
          setActionError(errorMessage(caught));
        });
    },
    [addRootDirectoryByPath]
  );

  const onArchive = useCallback(
    (card: WorktreeMapCardModel) => {
      const worktreeId = card.entry.id;
      if (!worktreeId || !worktrees) {
        setActionError(`"${card.entry.name}" is not a managed worktree yet.`);
        return;
      }
      setActionError(null);
      worktrees
        .archive({ worktreeId })
        .then((result) => {
          // GitResult refusal: state it verbatim (`use-worktree-mode.ts:373-374`).
          if (!result.ok) {
            setActionError(`Worktree not archived: ${result.error}`);
          }
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not archive', { error: caught, worktreeId });
          setActionError(errorMessage(caught));
        });
    },
    [worktrees]
  );

  // The FIRST real caller of `worktrees.adopt` (Task 2 shipped the service
  // and bridge method, but the picker's own call turned out unreachable and
  // was removed — A1/A7). `WorktreeAdoptParams` takes `createdBy` + `path`
  // only, never `branch` — match that real shipped shape, not a guess at it.
  const onAdopt = useCallback(
    (card: WorktreeMapCardModel) => {
      if (!worktrees) {
        setActionError('Adopting a worktree is unavailable in this build.');
        return;
      }
      setActionError(null);
      worktrees
        .adopt({ createdBy: 'user', path: card.entry.path })
        .then((result) => {
          // GitResult refusal: state it verbatim (`use-worktree-mode.ts:373-374`).
          if (!result.ok) {
            setActionError(`Could not adopt "${card.entry.name}": ${result.error}`);
            return;
          }
          void refresh();
        })
        .catch((caught: unknown) => {
          logger.error('worktree map could not adopt', { error: caught, path: card.entry.path });
          setActionError(errorMessage(caught));
        });
    },
    [refresh, worktrees]
  );

  if (loading && repositories.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading worktrees…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {/* A stated failure, NEVER the empty state: "no worktrees" is a
          different, honest fact and must not stand in for "the read failed". */}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
      {actionError ? <p className="text-destructive text-sm">{actionError}</p> : null}
      {repositories.length === 0 && !error ? (
        <p className="text-muted-foreground text-sm">{EMPTY_STATE}</p>
      ) : null}
      {repositories.map((repository) => (
        <section className="flex min-w-0 flex-col gap-2" key={repository.repoCommonDir}>
          <h2 className="font-medium text-sm">{repository.repositoryName}</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {repository.cards.map((card) => (
              <WorktreeMapCard
                card={card}
                key={card.entry.path}
                onAddAsRoot={onAddAsRoot}
                onAdopt={onAdopt}
                onArchive={onArchive}
                onNewThread={onNewThread}
                onOpenPullRequest={(url) => {
                  void platform?.openExternal(url);
                }}
                onOpenThread={(threadId) => selectThread(resourceId, threadId)}
                onReveal={(path) => {
                  void platform?.showItemInFolder(path);
                }}
                onToggleIndexing={setWorktreeRootIndexingEnabled}
                status={statusByPath.get(card.entry.path)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
```

> **Four wiring notes.** **(a)** Reveal and Open-PR go through `resolvePlatformBridge()` — the capability-resolved app-shell bridge, resolved once with `useMemo` and `null` on web — never `window.platform` / `window.electronAPI` directly and never a bare `<a href>`. That is the idiom `use-worktree-mode.ts` already uses for `showItemInFolder`, and it is what makes the Map degrade by omission on web instead of throwing. **(b)** `onAddAsRoot` / `onArchive` are fully inlined above — `useFileSystem().addRootDirectoryByPath(path)` (desktop-only, `undefined` on web; `use-workspace-bar.ts:918-942` is the precedent) and `worktrees.archive({ worktreeId })` respectively, each stating a `GitResult` refusal verbatim in `actionError` the way `use-worktree-mode.ts` does. The Step-4 suite pins both seams (`archive` called with the card's `worktreeId`; `addRootDirectoryByPath` called with the card's path), so a stub cannot survive review. **(c)** `onAdopt` calls `worktrees.adopt({ createdBy: 'user', path: card.entry.path })` — the REAL shipped `WorktreeAdoptParams` shape (`createdBy` + `path` only; there is no `branch` field), same `GitResult`-refusal-verbatim handling, then `void refresh()` on success so the card's `managed`/`usable` flip without waiting for the next `changes:invalidated` tick. This is the FIRST real UI caller of `worktrees.adopt` — Task 2 shipped the service/bridge method, but the Mode chip's picker call it originally planned turned out unreachable and was removed (A1/A7); the Step-4 suite pins this seam too (`adopt` called with the card's path; refusal stated verbatim). **(d)** `min-w-0` on the `<section>` is load-bearing: without it a flex child refuses to shrink and the LANE's `overflow-x-auto` never engages, pushing the page body into a horizontal scroll instead.

`index.ts`:

```ts
export { useWorktreeMap } from './use-worktree-map';
export { WorktreeMapSurface } from './worktree-map-surface';
```

- [ ] **Step 6: Run the app-shell lane**

```bash
pnpm --filter @brainstrike/app-shell vitest run src/worktree-map src/__tests__/worktree-checkout-intent-store.test.ts src/__tests__/use-workspace-bar-mode.test.tsx
```

Expected: green, with no `act()` warnings.

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/worktree-map packages/app-shell/src/stores/worktree-checkout-intent-store.ts packages/app-shell/src/hooks/use-workspace-bar-mode.ts
git add -A
git commit -m "feat(BST-1392): the Worktree Map surface and the checkout-intent seam

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Register the Map as a workspace app tab

**Files:**
- Modify: `packages/file-explorer-ui/src/shell/workspace-app.ts`
- Modify: `packages/app-shell/src/build-workspace-apps.tsx`
- Modify: `packages/app-shell/src/__tests__/build-workspace-apps.test.tsx`
- Modify: `packages/app-shell/src/root-layout-content.tsx`
- Modify: `packages/app-shell/package.json`
- Create: `apps/desktop/src/renderer/components/worktree-map-page-content.tsx`
- Modify: `apps/desktop/src/renderer/components/root-layout-content.tsx`
- Modify: `apps/desktop/src/__tests__/renderer/components/root-layout-content.test.tsx`

- [ ] **Step 1: Write the failing registration test**

In `packages/app-shell/src/__tests__/build-workspace-apps.test.tsx`:

```tsx
  it('places the Worktree Map after Changes and before Canvas when EVERY app is registered', () => {
    // All four optional contents present, deliberately: an ordering assertion
    // with only two of them cannot tell "after Changes" from "appended last",
    // which is exactly the mistake a new push() at the end of the builder makes.
    const apps = buildWorkspaceApps({
      canvasPanelContent: <div>canvas</div>,
      changesPageContent: <div>changes</div>,
      filesContent: <div>files</div>,
      terminalPageContent: <div>terminal</div>,
      worktreeMapPageContent: <div>map</div>,
    });

    expect(apps.map((app) => app.id)).toEqual([
      CONTEXT_EXPLORER_APP_ID,
      CHANGES_APP_ID,
      WORKTREE_MAP_APP_ID,
      CANVAS_APP_ID,
      TERMINAL_APP_ID,
    ]);
    expect(apps.find((app) => app.id === WORKTREE_MAP_APP_ID)?.label).toBe('Worktrees');
  });

  it('registers the Worktree Map even when Changes is absent', () => {
    // Independence: the Map's registration must not be nested under, or
    // ordered relative to, a sibling that happens to be missing.
    const apps = buildWorkspaceApps({
      filesContent: <div>files</div>,
      worktreeMapPageContent: <div>map</div>,
    });

    expect(apps.map((app) => app.id)).toEqual([CONTEXT_EXPLORER_APP_ID, WORKTREE_MAP_APP_ID]);
  });

  it('omits the Worktree Map entirely when no content is supplied (web)', () => {
    const apps = buildWorkspaceApps({ filesContent: <div>files</div> });

    expect(apps.map((app) => app.id)).toEqual([CONTEXT_EXPLORER_APP_ID]);
  });
```

```bash
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/build-workspace-apps.test.tsx
```

Expected: `WORKTREE_MAP_APP_ID is not exported`.

- [ ] **Step 2: Add the id and the registration**

`packages/file-explorer-ui/src/shell/workspace-app.ts`:

```ts
export const CHANGES_APP_ID = 'changes';
export const CANVAS_APP_ID = 'canvas';
export const TERMINAL_APP_ID = 'terminal';
export const WORKTREE_MAP_APP_ID = 'worktree-map';
```

`packages/app-shell/src/build-workspace-apps.tsx` — canonical display order becomes Files, Changes, Worktrees, Canvas, Terminal (the Map sits beside Changes because both answer "what is the state of my repositories"):

```tsx
import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
  type WorkspaceApp,
  WORKTREE_MAP_APP_ID,
} from '@brainstrike/file-explorer-ui/shell';
import { Files, GitCompare, PanelsTopLeft, SquareTerminal, Trees } from 'lucide-react';
```

```tsx
  if (worktreeMapPageContent) {
    apps.push({
      icon: Trees,
      id: WORKTREE_MAP_APP_ID,
      label: 'Worktrees',
      render: () => worktreeMapPageContent,
    });
  }
```

…with `worktreeMapPageContent?: ReactNode` added to the args interface (alphabetically last) and destructured.

- [ ] **Step 3: Thread the prop through the shared layout**

`packages/app-shell/src/root-layout-content.tsx` — add `worktreeMapPageContent?: ReactNode` to `RootLayoutContentProps` and to the inner props interface, pass it into `buildWorkspaceApps` with the same conditional-spread idiom the siblings use, and add it to that `useMemo`'s dependency array:

```tsx
      buildWorkspaceApps({
        ...(canvasPanelContent ? { canvasPanelContent } : {}),
        ...(changesPageContent ? { changesPageContent } : {}),
        filesContent,
        ...(terminalPageContent ? { terminalPageContent } : {}),
        ...(worktreeMapPageContent ? { worktreeMapPageContent } : {}),
      }),
```

- [ ] **Step 4: Add the desktop lazy wrapper and the capability gate**

Create `apps/desktop/src/renderer/components/worktree-map-page-content.tsx`:

```tsx
import { lazy, type ReactElement, Suspense } from 'react';

// Code-split the Worktree Map (BST-1392) so it only loads when the desktop
// user opens the Worktrees tab. Mirrors `changes-page-content.tsx`: the
// wrapper is rendered only when `window.worktrees` is present (the capability
// gate lives where the tab is wired), so there is no `isElectron()` check here.
const WorktreeMapSurface = lazy(() =>
  import('@brainstrike/app-shell/worktree-map').then((m) => ({ default: m.WorktreeMapSurface }))
);

export function WorktreeMapPageContent(): ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          Loading Worktrees…
        </div>
      }
    >
      <WorktreeMapSurface />
    </Suspense>
  );
}
```

> **The wrapper passes NOTHING, and that is the whole wiring.** It mirrors `changes-page-content.tsx` exactly: a lazy import plus a `Suspense` fallback, rendering a zero-prop surface. Everything the Map needs is resolved INSIDE `WorktreeMapSurface`, from providers that already wrap the workspace tab area:
>
> | Need | Resolved by | Already mounted because |
> | --- | --- | --- |
> | PGlite handle | `usePGliteDatabase()` | `RootLayoutContent` renders the workspace inside the DB provider — the same reason `ThreadsPanel` can call it |
> | Memory resource | `WORKSPACE_MEMORY_RESOURCE_ID` from `@brainstrike/assistant-data` | A module constant, not context (`threads-panel.tsx:2776` uses it the same way) |
> | Running threads | `useActiveAssistantThreadIds({ database, resourceId, schemaReady })` | `schemaReady` is `Object.hasOwn(threadsByResourceId, resourceId)`, the exact gate `threads-panel.tsx` uses — the run-events table is renderer-lazy and querying it early is a missing-relation error, not an empty result |
> | Thread create/select | `useAssistantThreadStore` | A module-scoped zustand store, no provider needed |
> | Reveal / open PR | `resolvePlatformBridge()` | Capability-resolved once via `useMemo`, `null` on web — the same idiom `use-worktree-mode.ts` uses for `showItemInFolder` |
>
> Do not add a props interface to the surface "for testability": the Step-4 suite mocks these five seams directly, which is both closer to what ships and the pattern the Changes suites already use.

`packages/app-shell/package.json` gains the export (keep the block's existing ordering style):

```json
    "./worktree-map": {
      "types": "./dist/worktree-map/index.d.ts",
      "import": "./dist/worktree-map/index.js"
    },
```

`apps/desktop/src/renderer/components/root-layout-content.tsx`:

```tsx
import { isWorktreesBridgeAvailable } from '@brainstrike/app-shell/worktrees/availability';
```

```tsx
  // Capability gate: only surface the Worktrees tab when the desktop
  // `window.worktrees` bridge is present (no isElectron check). Resolved once.
  const worktreesAvailable = useMemo(() => isWorktreesBridgeAvailable(), []);
```

```tsx
    ...(terminalAvailable ? { terminalPageContent: <TerminalPageContent /> } : {}),
    ...(worktreesAvailable ? { worktreeMapPageContent: <WorktreeMapPageContent /> } : {}),
```

> Import the capability from the dependency-light `/worktrees/availability` subpath, never from `/worktree-map` — importing the surface at startup would defeat the code split. The same comment the Changes gate carries applies verbatim.

- [ ] **Step 5: Pin the desktop gate**

In `apps/desktop/src/__tests__/renderer/components/root-layout-content.test.tsx`, add the pair the sibling gates already have:

```tsx
  it('registers the Worktrees tab when window.worktrees is present', () => {
    stubWorktreesBridge();
    render(<RootLayoutContent />);
    expect(capturedProps?.worktreeMapPageContent).toBeDefined();
  });

  it('omits the Worktrees tab entirely when window.worktrees is absent', () => {
    render(<RootLayoutContent />);
    expect(capturedProps?.worktreeMapPageContent).toBeUndefined();
  });
```

- [ ] **Step 6: Run every affected lane**

```bash
pnpm --filter @brainstrike/file-explorer-ui vitest run
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/build-workspace-apps.test.tsx src/__tests__/root-layout-content.test.tsx src/worktree-map
pnpm --filter @brainstrike/desktop vitest run src/__tests__/renderer/components/root-layout-content.test.tsx
pnpm run type-check
pnpm run react-doctor
```

Expected: green; React Doctor reports no NEW error-severity findings in the touched files.

- [ ] **Step 7: CDT verification (definition of done for this task)**

(Step 7 routed to Task 14's CDT pass — coordinator ruling)

Attach to the running renderer and report COMPUTED VALUES — not impressions:

1. Open the "+" workspace add menu; assert `Worktrees` is listed with the tree icon.
2. Open the tab; report `document.querySelectorAll('[data-testid="worktree-map-card"]').length` and, for the first card, its `getBoundingClientRect()`, its `provenanceLabel` text, and the `aria-label` of every glyph.
3. Report `document.querySelector('[data-testid="worktree-map-new-thread"]').disabled` for a usable and an unusable card, and the `title` attribute carrying the disabled reason.
4. Force a `changes:invalidated` (touch `.git/HEAD` in a repo) and report that the card count and status glyphs refresh with no page reload.
5. Capture the pane at 1440 px and at the narrow container-query breakpoint; report that the lane scrolls horizontally and the page body's `scrollWidth === clientWidth`.

- [ ] **Step 8: Commit and submit**

```bash
pnpm dlx ultracite fix packages/app-shell/src packages/file-explorer-ui/src/shell/workspace-app.ts apps/desktop/src/renderer/components
git add -A
git commit -m "feat(BST-1392): register the Worktree Map workspace app tab

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---
# Layer 3 — Agent worktree tools

**Branch:** `seandearnaley/bst-1392-w5-agent-tools` (stacked on Layer 2 for landing; DEVELOPED in parallel with Layer 2 from the Layer 1 tip — the file sets are disjoint, so rebase before `gh stack submit`)

```bash
gh stack add seandearnaley/bst-1392-w5-agent-tools
```

**Two ids, not three [A6]:** `brainstrike.listWorktrees` (read risk, no approval) and `brainstrike.manageWorktree` (`create` | `archive`, execute risk, approval required).

---

### Task 8: The catalog — five registration sites in `@brainstrike/assistant-contract`

**Files:**
- Modify: `packages/assistant-contract/src/native-tool-catalog.ts`
- Modify: `packages/assistant-contract/src/tool-categories.ts`
- Modify: `packages/assistant-contract/src/tool-descriptions.ts`
- Modify: `packages/assistant-contract/src/tool-discovery.ts`
- Modify: `packages/assistant-contract/src/tool-schemas-display-workspace.ts`
- Modify: `packages/assistant-contract/src/__tests__/tool-risk.test.ts`
- Modify: `packages/assistant-contract/src/__tests__/native-tool-catalog.test.ts` — **three hand-maintained fixtures in this one file**, all of which fail loudly and none of which is derived from the catalog:
  1. `EXPECTED_DESKTOP_NATIVE_TOOL_IDS` (the literal id array at the top) gains `'brainstrike.listWorktrees'` and `'brainstrike.manageWorktree'`.
  2. `expect(desktopIds).toHaveLength(34)` → `toHaveLength(36)`.
  3. The **third copy of the web-exclusion list** — the inline `desktopIds.filter((id) => id !== 'brainstrike.browserGetPageText' && …)` inside the `webIds` assertion — gains `id !== 'brainstrike.listWorktrees' && id !== 'brainstrike.manageWorktree'`. `expect(webIds).toHaveLength(24)` is UNCHANGED: both new ids are desktop-only, so the web count does not move.
- Modify: `packages/assistant-contract/src/__tests__/tool-discovery-contract.test.ts` (its own hardcoded namespace-membership list)

- [ ] **Step 1: Run the parity tests to see them fail as you go**

Each sub-step below is followed by the same command; run it after EVERY sub-step so a missed site fails immediately rather than at the end:

```bash
pnpm --filter @brainstrike/assistant-contract vitest run
```

- [ ] **Step 2: Site 1 — the canonical ids and the web omissions**

`native-tool-catalog.ts`, inside `DESKTOP_NATIVE_TOOL_ID` (alphabetical):

```ts
  listWorkspaceContext: 'brainstrike.listWorkspaceContext',
  listWorktrees: 'brainstrike.listWorktrees',
  lspInspect: 'brainstrike.lspInspect',
  manageCanvas: 'brainstrike.manageCanvas',
  manageCommandSession: 'brainstrike.manageCommandSession',
  manageTaskList: 'brainstrike.manageTaskList',
  manageWorktree: 'brainstrike.manageWorktree',
```

Both are desktop-only: git worktrees are a filesystem capability the web assistant server has no bridge to. Add them to BOTH hand-maintained web lists — the type exclusion:

```ts
export type WebNativeToolId = Exclude<
  DesktopNativeToolId,
  | typeof NATIVE_TOOL_ID.browserGetPageText
  | typeof NATIVE_TOOL_ID.browserNavigate
  | typeof NATIVE_TOOL_ID.browserReadPage
  | typeof NATIVE_TOOL_ID.inspectCommandSessions
  | typeof NATIVE_TOOL_ID.listWorktrees
  | typeof NATIVE_TOOL_ID.manageCanvas
  | typeof NATIVE_TOOL_ID.manageCommandSession
  | typeof NATIVE_TOOL_ID.manageWorktree
  | typeof NATIVE_TOOL_ID.queryDiagnostics
  | typeof NATIVE_TOOL_ID.querySelf
  | typeof NATIVE_TOOL_ID.runPython
  | typeof NATIVE_TOOL_ID.runSkillScript
>;
```

…and the runtime filter, which is a SEPARATE list that must be edited too:

```ts
      id !== NATIVE_TOOL_ID.inspectCommandSessions &&
      id !== NATIVE_TOOL_ID.listWorktrees &&
      id !== NATIVE_TOOL_ID.manageCanvas &&
      id !== NATIVE_TOOL_ID.manageCommandSession &&
      id !== NATIVE_TOOL_ID.manageWorktree &&
```

Neither joins `LOCAL_DESKTOP_NATIVE_TOOL_IDS`: the built-in on-device model's prefill budget cannot afford an approval-gated mutation surface it will never see reflected back (the same reasoning that keeps `manageTaskList` out).

**The web-exclusion list exists in THREE places** and none derives from another — a change to one silently passes the others until a test runs:

| # | Location | Shape |
| --- | --- | --- |
| 1 | `native-tool-catalog.ts` `WebNativeToolId` | `\| typeof NATIVE_TOOL_ID.listWorktrees` (type-level `Exclude`) |
| 2 | `native-tool-catalog.ts` `WEB_NATIVE_TOOL_IDS` | `id !== NATIVE_TOOL_ID.listWorktrees &&` (runtime filter) |
| 3 | `__tests__/native-tool-catalog.test.ts` `webIds` assertion | `id !== 'brainstrike.listWorktrees' &&` (string literals, not constants) |

Edit all three in the same commit. #3 is the one that catches a mismatch between #1 and #2.

- [ ] **Step 3: Site 2 — risk and loading tier**

`tool-categories.ts`, in `NATIVE_TOOL_DEFAULTS` (alphabetical by id constant), each with the mandatory justification comment:

```ts
  // Read-only orientation. Deliberately NOT execute-risk even though its
  // siblings mutate: an agent must be able to answer "which worktrees exist"
  // while plan mode is suspending mutations, and `resolveToolRiskCategory`
  // derives 'read' from `category: 'analysis'` + no approval only when the
  // classification is honest. It touches no worktree and runs no git mutation —
  // WorktreeService.list() is inventory ⋈ ledger.
  [NATIVE_TOOL_ID.listWorktrees]: {
    category: 'analysis',
    estimatedTokens: 90,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
```

```ts
  // Creates and archives real linked worktrees on disk (spec §6.4: "execute-risk
  // → permission engine"). `create` forks a `git worktree add` and may run the
  // repository's setup command; `archive` removes a directory after capturing a
  // restorable snapshot. Both are approval-gated for the same reason
  // `manageCommandSession` is: the model is asking the host to run git against
  // the user's checkout. The read-only listing lives in its OWN tool
  // (`listWorktrees`) precisely so this classification can stay strict.
  [NATIVE_TOOL_ID.manageWorktree]: {
    category: 'action',
    estimatedTokens: 190,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'execute',
  },
```

`packages/assistant-contract/src/__tests__/tool-risk.test.ts` maintains two hand-written sets. Add `NATIVE_TOOL_ID.manageWorktree` to `explicitlyNonRead` and to the execute-tools expectation beside `manageCommandSession`; `listWorktrees` needs no entry (it resolves to `'read'` like every other analysis tool, which the "classifies every other current native tool as 'read'" case already covers).

- [ ] **Step 4: Site 3 — model-facing descriptions**

`tool-descriptions.ts` (the map is `satisfies Record<NativeToolId, string>`, so a missing key is a COMPILE error):

```ts
  [NATIVE_TOOL_ID.listWorktrees]:
    'List every git worktree the workspace knows about: path, branch, whether BrainStrike manages it, whether it is usable, and if not, why. Read-only.',
  [NATIVE_TOOL_ID.manageWorktree]:
    'Create an isolated git worktree for the current repository, or archive one. create takes a branch name and a base ref; archive takes the worktree id from listWorktrees and refuses a dirty or in-use worktree unless force is set. Archiving always captures a restorable snapshot first.',
```

- [ ] **Step 5: Site 4 — the deferred discovery namespace**

`tool-discovery.ts`, in `NATIVE_TOOL_DISCOVERY_NAMESPACES.workspace` (4 → 6 ids, well under the 9 cap), and widen the summary so discovery search can find them:

```ts
  workspace: {
    summary:
      'Perform specialist workspace mutations, manage isolated git worktrees, and maintain Canvas documents or tasks.',
    toolIds: [
      NATIVE_TOOL_ID.deleteWorkspaceFile,
      NATIVE_TOOL_ID.listWorktrees,
      NATIVE_TOOL_ID.manageCanvas,
      NATIVE_TOOL_ID.manageTaskList,
      NATIVE_TOOL_ID.manageWorktree,
      NATIVE_TOOL_ID.renameWorkspaceFile,
    ],
  },
```

- [ ] **Step 6: Site 5 — display schemas**

Append to `packages/assistant-contract/src/tool-schemas-display-workspace.ts` (an EXISTING data module — adding a new `tool-schemas-display-*.ts` file would also have to satisfy the display-boundary test, and there is no reason to). The parameter names, enum options and required-ness must match Task 9's Zod schemas EXACTLY; `native-tool-display-schema-parity.spec.ts` compares them mechanically.

```ts
  'brainstrike.listWorktrees': {
    description:
      'List every git worktree the workspace knows about, with its usability and the reason when it is not usable.',
    parameters: [
      {
        description:
          'Workspace root id or display name to scope the listing to; omit to list every open root',
        minLength: 1,
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'worktrees[]: { branch, detached, disabledReason, externalTool, managed, name, path, primary, provenance, repositoryRoot, usable, worktreeId }. An unusable worktree is listed with its reason, never omitted.',
    toolId: 'brainstrike.listWorktrees',
  },
  'brainstrike.manageWorktree': {
    description: 'Create an isolated git worktree, or archive one with a restorable snapshot.',
    parameters: [
      {
        description: 'Operation: create a new worktree, or archive an existing one',
        enumValues: ['create', 'archive'],
        name: 'action',
        required: true,
        type: 'enum',
      },
      {
        description: 'Branch to create in the new worktree; required for create',
        minLength: 1,
        name: 'branch',
        required: false,
        type: 'string',
      },
      {
        description: 'Base ref to start the new worktree from; defaults to HEAD',
        minLength: 1,
        name: 'baseRef',
        required: false,
        type: 'string',
      },
      {
        description: 'Directory name for the new worktree; defaults to the branch name',
        minLength: 1,
        name: 'name',
        required: false,
        type: 'string',
      },
      {
        description:
          'Workspace root id or display name the worktree belongs to; omit when one folder is open',
        minLength: 1,
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        description: 'Worktree id from listWorktrees; required for archive',
        minLength: 1,
        name: 'worktreeId',
        required: false,
        type: 'string',
      },
      {
        description:
          'Archive a dirty or unpushed worktree anyway; the snapshot is captured either way. Never overrides an active run',
        name: 'force',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'create returns { worktreeId, path, branch, setupStatus, setupReason }; archive returns { worktreeId, snapshotRef }. A refusal returns its reason verbatim.',
    toolId: 'brainstrike.manageWorktree',
  },
```

- [ ] **Step 7: Run the contract lane to green**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run
```

Expected: green, including `native-tool-catalog.test.ts` (ids, web exclusions, exact registry parity, `toolId` self-identity), `tool-descriptions.test.ts`, `tool-discovery-contract.test.ts` (namespace reachability and the ≤9 cap) and `tool-risk.test.ts`.

- [ ] **Step 8: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-contract/src
git add packages/assistant-contract
git commit -m "feat(BST-1392): catalog the two worktree agent tools

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Execution schemas, exports and capability advertisement

**Files:**
- Create: `packages/agent/src/tools/schemas-worktrees.ts`
- Create: `packages/agent/src/__tests__/worktree-tool-schemas.spec.ts`
- Modify: `packages/agent/src/tools/schemas.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/src/mastra/deferred-capability-families.ts`
- Modify: `packages/agent/src/__tests__/native-tool-input-schema-catalog.spec.ts` — its own hardcoded expected-id array (the one containing `'brainstrike.manageCanvas'`) gains both ids; the parity assertion compares that literal list against `NATIVE_TOOL_INPUT_SCHEMAS`' keys, so a missing entry reads as "extra schema key" rather than "missing fixture"

**Interfaces:**
```ts
export type ListWorktreesInput = z.infer<typeof ListWorktreesInputSchema>;
export const ListWorktreesInputSchema: z.ZodType;
export type ManageWorktreeInput = z.infer<typeof ManageWorktreeActionInputSchema>;
export const ManageWorktreeInputSchema: z.ZodType;
export function normalizeManageWorktreeInput(input: unknown): ManageWorktreeInput;
```

- [ ] **Step 1: Write the failing schema test**

Create `packages/agent/src/__tests__/worktree-tool-schemas.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ListWorktreesInputSchema,
  ManageWorktreeInputSchema,
  normalizeManageWorktreeInput,
} from '../tools/schemas-worktrees';

describe('ListWorktreesInputSchema', () => {
  it('accepts an empty object and an explicit root', () => {
    expect(ListWorktreesInputSchema.parse({})).toEqual({});
    expect(ListWorktreesInputSchema.parse({ root: 'brainstrike' })).toEqual({ root: 'brainstrike' });
  });

  it('rejects an unknown key at the strict provider envelope', () => {
    expect(() => ListWorktreesInputSchema.parse({ rootId: 'x' })).toThrow();
  });
});

describe('ManageWorktreeInputSchema', () => {
  it('accepts a create with a branch', () => {
    expect(() => ManageWorktreeInputSchema.parse({ action: 'create', branch: 'bs/fox' })).not.toThrow();
  });

  it('rejects a create with no branch, naming the missing field', () => {
    const result = ManageWorktreeInputSchema.safeParse({ action: 'create' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('branch');
  });

  it('rejects an archive with no worktreeId', () => {
    expect(ManageWorktreeInputSchema.safeParse({ action: 'archive' }).success).toBe(false);
  });

  it('tolerates cross-action extras among the declared envelope keys', () => {
    // The settled manageCanvas ruling (2026-08-07): real models bundle fields,
    // and rejecting a VALID create that carries a stray worktreeId burns retry
    // tokens for nothing. `action` fully determines semantics.
    expect(() =>
      ManageWorktreeInputSchema.parse({ action: 'create', branch: 'bs/fox', worktreeId: 'wt-1' })
    ).not.toThrow();
  });

  it('rejects a genuinely unknown key', () => {
    expect(() =>
      ManageWorktreeInputSchema.parse({ action: 'create', branch: 'bs/fox', detach: true })
    ).toThrow();
  });

  it('normalizes to the clean action branch, stripping tolerated extras', () => {
    expect(
      normalizeManageWorktreeInput({ action: 'create', branch: 'bs/fox', worktreeId: 'wt-1' })
    ).toEqual({ action: 'create', branch: 'bs/fox' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/agent vitest run src/__tests__/worktree-tool-schemas.spec.ts
```

Expected: unresolved import.

- [ ] **Step 3: Write the schemas**

Create `packages/agent/src/tools/schemas-worktrees.ts`:

```ts
/**
 * Execution schemas for the two worktree agent tools (BST-1392, spec §6.4).
 *
 * `manageWorktree` follows the settled `manageCanvas` shape: a STRICT root
 * object (provider schemas must be root JSON objects — a raw discriminated
 * union serializes as a root `oneOf` and is rejected by the native-tool prompt
 * contract) whose conditional validation delegates to a canonical action union.
 */
import { z } from 'zod';

const BRANCH_MAX = 255;
const NAME_MAX = 128;
const REF_MAX = 255;
const ROOT_MAX = 512;

export const ListWorktreesInputSchema = z
  .object({
    root: z
      .string()
      .min(1)
      .max(ROOT_MAX)
      .optional()
      .describe('Workspace root id or display name; omit to list every open root'),
  })
  .strict();

export type ListWorktreesInput = z.infer<typeof ListWorktreesInputSchema>;

// Branches deliberately STRIP (zod default) rather than `.strict()`: `action`
// fully determines semantics, and models bundle fields from the other action.
// Genuinely unknown keys are still rejected by the strict envelope below.
const ManageWorktreeActionInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    baseRef: z.string().min(1).max(REF_MAX).optional().describe('Base ref; defaults to HEAD'),
    branch: z.string().min(1).max(BRANCH_MAX).describe('Branch to create in the new worktree'),
    name: z.string().min(1).max(NAME_MAX).optional().describe('Directory name; defaults to the branch name'),
    root: z.string().min(1).max(ROOT_MAX).optional().describe('Workspace root id or display name'),
  }),
  z.object({
    action: z.literal('archive'),
    force: z
      .boolean()
      .optional()
      .describe('Archive a dirty or unpushed worktree anyway; never overrides an active run'),
    worktreeId: z.string().min(1).describe('Worktree id from listWorktrees'),
  }),
]);

export type ManageWorktreeInput = z.infer<typeof ManageWorktreeActionInputSchema>;

export function normalizeManageWorktreeInput(input: unknown): ManageWorktreeInput {
  return ManageWorktreeActionInputSchema.parse(input);
}

export const ManageWorktreeInputSchema = z
  .object({
    action: z.enum(['create', 'archive']).describe('Worktree operation'),
    baseRef: z.string().min(1).max(REF_MAX).optional().describe('Base ref for create; defaults to HEAD'),
    branch: z.string().min(1).max(BRANCH_MAX).optional().describe('Required for create'),
    force: z
      .boolean()
      .optional()
      .describe('Archive a dirty or unpushed worktree anyway; never overrides an active run'),
    name: z.string().min(1).max(NAME_MAX).optional().describe('Directory name; defaults to the branch name'),
    root: z.string().min(1).max(ROOT_MAX).optional().describe('Workspace root id or display name'),
    worktreeId: z.string().min(1).optional().describe('Required for archive'),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = ManageWorktreeActionInputSchema.safeParse(input);
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  });
```

- [ ] **Step 4: Register and export**

`packages/agent/src/tools/schemas.ts` — import block plus the two `NATIVE_TOOL_INPUT_SCHEMAS` entries (the map is `satisfies Record<DesktopNativeToolId, z.ZodSchema>`, so omission is a compile error):

```ts
import { ListWorktreesInputSchema, ManageWorktreeInputSchema } from './schemas-worktrees.js';
```

```ts
  [NATIVE_TOOL_ID.listWorktrees]: ListWorktreesInputSchema,
  [NATIVE_TOOL_ID.manageWorktree]: ManageWorktreeInputSchema,
```

`packages/agent/src/index.ts` — alphabetical entries in the `./tools/schemas` export block:

```ts
  type ListWorktreesInput,
  ListWorktreesInputSchema,
  type ManageWorktreeInput,
  ManageWorktreeInputSchema,
  normalizeManageWorktreeInput,
```

`packages/agent/src/mastra/deferred-capability-families.ts` — every non-critical tool MUST belong to a family, or `default-instructions.spec.ts` fails with "deferred tool <id> belongs to no capability family". One family covers both:

```ts
  { ids: [NATIVE_TOOL_ID.listWorktrees, NATIVE_TOOL_ID.manageWorktree], phrase: 'git worktrees' },
```

No bespoke `default-instructions.ts` guidance: the two descriptions carry the whole contract, and every instruction line costs prompt budget the tools already spend.

- [ ] **Step 5: Run the agent lane**

```bash
pnpm --filter @brainstrike/agent vitest run
```

Expected: green — `native-tool-input-schema-catalog.spec.ts` (exact parity), `native-tool-display-schema-parity.spec.ts` (Task 8's display data vs these Zod schemas), `default-instructions.spec.ts` (capability families, and the web case that must NOT advertise them).

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix packages/agent/src
git add packages/agent
git commit -m "feat(BST-1392): worktree tool schemas, exports and capability family

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Executors, the live desktop registry, and the prompt-budget ledger

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-tools.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/worktree-tools.test.ts`
- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts`
- Modify: `apps/desktop/src/assistant-server/server-options.ts`
- Modify: `apps/desktop/src/assistant-server.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/__tests__/assistant-server/assistant-tools-multiroot-and-gating.integration.test.ts`
- Modify: `apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`

**Interfaces:**
```ts
export interface WorktreeToolCapability {
  readonly archive: (params: { readonly force?: boolean; readonly worktreeId: string })
    => Promise<GitResult<WorktreeArchiveResult>>;
  readonly create: (params: {
    readonly baseRef: string;
    readonly branch: string;
    readonly name: string;
    readonly rootId: string;
  }) => Promise<GitResult<WorktreeCreateResult>>;
  readonly list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
}
export function runListWorktrees(
  input: ListWorktreesInput,
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Promise<ListWorktreesToolResult>;
export function runManageWorktree(
  input: ManageWorktreeInput,
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Promise<ManageWorktreeToolResult>;
export function buildWorktreeMastraTools(
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Record<string, unknown>;
```

**Why a capability object and not the service:** the tools must record `created_by='agent'` and the originating `run_id` (spec §6.4). `runId` is NOT in scope inside `buildDesktopAssistantTools` — `RuntimeData` has no such field — but it IS in scope at `apps/desktop/src/assistant-server.ts` where `initializeAgentStream({ runId: core.runId, toolDependencies: { … } })` is composed. The capability is therefore built there, closing over `core.runId`, `core.runtimeData?.memory?.threadId` and a lazily-resolved `WorktreeService`. This is exactly the `buildToolOutputArtifactCapabilities` precedent, and it means `assistant-tools.ts` grows by one dependency field and one spread — critical, because that file sits at 1004 lines against a 1000-line ceiling.

- [ ] **Step 1: Write the failing executor test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runListWorktrees, runManageWorktree } from '../../assistant-server/worktree-tools';

const RUNTIME = {
  workspaceRoots: [{ displayName: 'brainstrike', path: '/repo', rootId: 'root-1' }],
} as never;

function capability(overrides: Record<string, unknown> = {}) {
  return {
    archive: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    ...overrides,
  };
}

describe('runListWorktrees', () => {
  it('projects the ledger-joined listing, keeping unusable rows with their reasons', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            branch: 'main',
            detached: false,
            disabledReason: null,
            externalTool: null,
            id: null,
            managed: false,
            name: 'repo',
            path: '/repo',
            primary: true,
            provenance: 'scanned',
            repositoryRoot: '/repo',
            usable: false,
          },
          {
            branch: 'bs/fox',
            detached: false,
            disabledReason: 'Locked: rebase in progress',
            externalTool: 'claude-code',
            id: 'wt-1',
            managed: true,
            name: 'fox',
            path: '/wt',
            primary: false,
            provenance: 'both',
            repositoryRoot: '/repo',
            usable: false,
          },
        ],
      }),
    });

    const result = await runListWorktrees({}, RUNTIME, caps as never);

    expect(caps.list).toHaveBeenCalledTimes(1);
    expect(caps.create).not.toHaveBeenCalled();
    expect(caps.archive).not.toHaveBeenCalled();
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees[1]).toEqual({
      branch: 'bs/fox',
      detached: false,
      disabledReason: 'Locked: rebase in progress',
      externalTool: 'claude-code',
      managed: true,
      name: 'fox',
      path: '/wt',
      primary: false,
      provenance: 'both',
      repositoryRoot: '/repo',
      usable: false,
      worktreeId: 'wt-1',
    });
  });

  it('scopes to one root when `root` is supplied', async () => {
    const caps = capability({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          { branch: null, disabledReason: null, id: 'a', name: 'a', path: '/a', primary: false, repositoryRoot: '/repo', usable: true },
          { branch: null, disabledReason: null, id: 'b', name: 'b', path: '/b', primary: false, repositoryRoot: '/other', usable: true },
        ],
      }),
    });

    const result = await runListWorktrees({ root: 'brainstrike' }, RUNTIME, caps as never);

    expect(result.worktrees.map((worktree) => worktree.name)).toEqual(['a']);
  });

  it('throws a stated error when the capability is absent — never an empty list', async () => {
    await expect(runListWorktrees({}, RUNTIME, undefined)).rejects.toThrow(
      'Worktree management is not available in this session.'
    );
  });

  it('throws the service refusal verbatim', async () => {
    const caps = capability({ list: vi.fn().mockResolvedValue({ error: 'inventory failed', ok: false }) });

    await expect(runListWorktrees({}, RUNTIME, caps as never)).rejects.toThrow('inventory failed');
  });
});

describe('runManageWorktree', () => {
  it('creates through the capability, defaulting baseRef to HEAD and name to the branch leaf', async () => {
    const caps = capability({
      create: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          setup: { reason: null, status: 'none' },
          worktree: { branch: 'bs/fox', id: 'wt-9', path: '/managed/fox' },
        },
      }),
    });

    const result = await runManageWorktree(
      { action: 'create', branch: 'bs/fox' },
      RUNTIME,
      caps as never
    );

    expect(caps.create).toHaveBeenCalledTimes(1);
    expect(caps.create).toHaveBeenCalledWith({
      baseRef: 'HEAD',
      branch: 'bs/fox',
      name: 'fox',
      rootId: 'root-1',
    });
    expect(caps.archive).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'create',
      branch: 'bs/fox',
      path: '/managed/fox',
      setupReason: null,
      setupStatus: 'none',
      worktreeId: 'wt-9',
    });
  });

  it('archives through the capability and reports the snapshot ref', async () => {
    const caps = capability({
      archive: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          snapshotRef: 'refs/brainstrike/worktree-archive/wt-9',
          worktree: { id: 'wt-9', path: '/managed/fox' },
        },
      }),
    });

    const result = await runManageWorktree(
      { action: 'archive', worktreeId: 'wt-9' },
      RUNTIME,
      caps as never
    );

    expect(caps.archive).toHaveBeenCalledTimes(1);
    expect(caps.archive).toHaveBeenCalledWith({ worktreeId: 'wt-9' });
    expect(caps.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      action: 'archive',
      snapshotRef: 'refs/brainstrike/worktree-archive/wt-9',
      worktreeId: 'wt-9',
    });
  });

  it('forwards force only when the model asked for it', async () => {
    const caps = capability({
      archive: vi.fn().mockResolvedValue({
        ok: true,
        value: { snapshotRef: 'ref', worktree: { id: 'wt-9', path: '/x' } },
      }),
    });

    await runManageWorktree({ action: 'archive', force: true, worktreeId: 'wt-9' }, RUNTIME, caps as never);

    expect(caps.archive).toHaveBeenCalledWith({ force: true, worktreeId: 'wt-9' });
  });

  it('throws an archive refusal verbatim so the model sees the blocker', async () => {
    const caps = capability({
      archive: vi
        .fn()
        .mockResolvedValue({ error: 'A run is active in this worktree.', ok: false }),
    });

    await expect(
      runManageWorktree({ action: 'archive', worktreeId: 'wt-9' }, RUNTIME, caps as never)
    ).rejects.toThrow('A run is active in this worktree.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-tools.test.ts
```

Expected: unresolved import.

- [ ] **Step 3: Write the executors**

Create `apps/desktop/src/assistant-server/worktree-tools.ts`:

```ts
/**
 * The two worktree agent tools (BST-1392, spec §6.4).
 *
 * They call the SAME `WorktreeService` the Mode chip calls — there is exactly
 * one worktree code path, and neither tool shells out to `git worktree`. The
 * capability object closes over the request's `runId`, `threadId` and
 * `createdBy: 'agent'`, so the ledger's provenance columns are filled by
 * construction rather than by a model-supplied field the model could lie about.
 *
 * Absence of the capability THROWS with a stated reason. Returning an empty
 * list would present "the service is not wired" as the different, honest fact
 * "this workspace has no worktrees".
 */
import type {
  GitResult,
  WorktreeArchiveResult,
  WorktreeCreateResult,
  WorktreeListEntry,
} from '@brainstrike/types';
import type { ListWorktreesInput, ManageWorktreeInput, RuntimeData } from '@brainstrike/agent';
import { NATIVE_TOOL_ID, TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_INPUT_SCHEMAS, normalizeManageWorktreeInput } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import { parseToolExecuteInput, type ToolExecuteInput } from './tool-execute-support';
import { resolveWorkspaceRoot } from './workspace-roots';

const logger = createLogger('WorktreeTools');

const UNAVAILABLE = 'Worktree management is not available in this session.';

export interface WorktreeToolCapability {
  readonly archive: (params: {
    readonly force?: boolean;
    readonly worktreeId: string;
  }) => Promise<GitResult<WorktreeArchiveResult>>;
  readonly create: (params: {
    readonly baseRef: string;
    readonly branch: string;
    readonly name: string;
    readonly rootId: string;
  }) => Promise<GitResult<WorktreeCreateResult>>;
  readonly list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
}

export interface ListedWorktree {
  readonly branch: string | null;
  readonly detached: boolean;
  readonly disabledReason: string | null;
  readonly externalTool: string | null;
  readonly managed: boolean;
  readonly name: string;
  readonly path: string;
  readonly primary: boolean;
  readonly provenance: string;
  readonly repositoryRoot: string;
  readonly usable: boolean;
  readonly worktreeId: string | null;
}

export interface ListWorktreesToolResult {
  readonly worktrees: readonly ListedWorktree[];
}

export type ManageWorktreeToolResult =
  | {
      readonly action: 'archive';
      readonly snapshotRef: string;
      readonly worktreeId: string;
    }
  | {
      readonly action: 'create';
      readonly branch: string | null;
      readonly path: string;
      readonly setupReason: string | null;
      readonly setupStatus: string;
      readonly worktreeId: string;
    };

function requireCapability(capability: WorktreeToolCapability | undefined): WorktreeToolCapability {
  if (!capability) {
    throw new Error(UNAVAILABLE);
  }
  return capability;
}

function project(entry: WorktreeListEntry): ListedWorktree {
  return {
    branch: entry.branch,
    detached: entry.detached,
    disabledReason: entry.disabledReason,
    externalTool: entry.externalTool,
    managed: entry.managed,
    name: entry.name,
    path: entry.path,
    primary: entry.primary,
    provenance: entry.provenance,
    repositoryRoot: entry.repositoryRoot,
    usable: entry.usable,
    worktreeId: entry.id,
  };
}

export async function runListWorktrees(
  input: ListWorktreesInput,
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Promise<ListWorktreesToolResult> {
  const listed = await requireCapability(capability).list();
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  if (input.root === undefined) {
    return { worktrees: listed.value.map(project) };
  }
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  return {
    worktrees: listed.value
      .filter((entry) => entry.repositoryRoot === root.path || entry.rootId === root.rootId)
      .map(project),
  };
}

/** `bs/bright-fox` → `bright-fox`: a directory name may not contain a slash. */
function directoryNameFor(branch: string): string {
  return branch.split('/').filter(Boolean).at(-1) ?? branch;
}

export async function runManageWorktree(
  input: ManageWorktreeInput,
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): Promise<ManageWorktreeToolResult> {
  const resolved = requireCapability(capability);
  if (input.action === 'archive') {
    const archived = await resolved.archive({
      ...(input.force === undefined ? {} : { force: input.force }),
      worktreeId: input.worktreeId,
    });
    if (!archived.ok) {
      throw new Error(archived.error);
    }
    return {
      action: 'archive',
      snapshotRef: archived.value.snapshotRef,
      worktreeId: archived.value.worktree.id,
    };
  }
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const created = await resolved.create({
    baseRef: input.baseRef ?? 'HEAD',
    branch: input.branch,
    name: input.name ?? directoryNameFor(input.branch),
    rootId: root.rootId,
  });
  if (!created.ok) {
    throw new Error(created.error);
  }
  return {
    action: 'create',
    branch: created.value.worktree.branch,
    path: created.value.worktree.path,
    setupReason: created.value.setup.reason,
    setupStatus: created.value.setup.status,
    worktreeId: created.value.worktree.id,
  };
}

/**
 * The two registry entries, keyed by canonical id. Named rather than inferred
 * so the return type is annotated at the function boundary (the repo's
 * "annotate params and return types" rule) and so a typo in a key is a compile
 * error here rather than a missing tool at runtime.
 */
export type WorktreeMastraTools = Record<
  typeof NATIVE_TOOL_ID.listWorktrees | typeof NATIVE_TOOL_ID.manageWorktree,
  {
    readonly description: string;
    readonly execute: (input: never) => Promise<unknown>;
    readonly id: string;
    readonly inputSchema: unknown;
  }
>;

/**
 * The Mastra registry fragment, built HERE rather than inline in
 * `assistant-tools.ts`: that file sits at the 1000-line Biome ceiling and this
 * keeps its growth to one spread.
 */
export function buildWorktreeMastraTools(
  runtimeData: RuntimeData | undefined,
  capability: WorktreeToolCapability | undefined
): WorktreeMastraTools {
  return {
    [NATIVE_TOOL_ID.listWorktrees]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.listWorktrees],
      execute: async (input: ToolExecuteInput<ListWorktreesInput>) => {
        const resolvedInput = parseToolExecuteInput(
          NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorktrees],
          input
        );
        try {
          return await runListWorktrees(resolvedInput, runtimeData, capability);
        } catch (error) {
          logger.error('listWorktrees failed', { error });
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.listWorktrees,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.listWorktrees],
    },
    [NATIVE_TOOL_ID.manageWorktree]: {
      description: TOOL_DESCRIPTIONS[NATIVE_TOOL_ID.manageWorktree],
      execute: async (input: ToolExecuteInput<ManageWorktreeInput>) => {
        // Envelope-validate, then narrow to the clean action branch so the
        // executor receives exactly ManageWorktreeInput (tolerated
        // cross-action extras are stripped here).
        const resolvedInput = normalizeManageWorktreeInput(
          parseToolExecuteInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageWorktree], input)
        );
        try {
          return await runManageWorktree(resolvedInput, runtimeData, capability);
        } catch (error) {
          logger.error('manageWorktree failed', { action: resolvedInput.action, error });
          throw error;
        }
      },
      id: NATIVE_TOOL_ID.manageWorktree,
      inputSchema: NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.manageWorktree],
    },
  };
}
```

- [ ] **Step 4: Register in the live desktop registry**

`apps/desktop/src/assistant-server/assistant-tools.ts` — one import, one dependency field, one spread.

> **Register inside the `isLocalProvider ? {} : { … }` spread, not unconditionally.** Task 8 kept both ids out of `LOCAL_DESKTOP_NATIVE_TOOL_IDS`, and the local-provider registration gate is how that exclusion is actually enforced at runtime — `inspectCommandSessions` and the two suspending tools sit in exactly this spread for exactly this reason (`assistant-tools.ts` ~line 637 and ~line 826). Registering unconditionally would advertise an approval-gated worktree mutation to the on-device model whose WebGPU prefill budget Task 8's rationale explicitly protects, i.e. the catalog would say one thing and the registry another. The registry-parity test builds with a HOSTED runtime, so it still sees the full `DESKTOP_NATIVE_TOOL_IDS` key set; there is no "registry always equals the catalog" invariant to violate, and neither id needs an `unavailableToolIds` exemption. A missing capability object remains a loud execute-time error, never an omitted tool.

```ts
import { buildWorktreeMastraTools, type WorktreeToolCapability } from './worktree-tools';
```

```ts
  webSearch?: WebSearchToolDependencies | undefined;
  /**
   * Request-scoped worktree capability (BST-1392). Built in
   * `assistant-server.ts`, where the run id is in scope, so the ledger records
   * `created_by='agent'` and the originating `run_id` by construction.
   */
  worktreeTools?: WorktreeToolCapability | undefined;
```

…and inside the EXISTING local-provider-gated spread in the `const tools: MastraTools = { … }` literal — the same one `inspectCommandSessions` occupies, so no new conditional block is introduced:

```ts
    ...(isLocalProvider
      ? {}
      : {
          [NATIVE_TOOL_ID.inspectCommandSessions]: {
            /* …unchanged… */
          },
          // BST-1392. Gated with its neighbours: both worktree ids are absent
          // from LOCAL_DESKTOP_NATIVE_TOOL_IDS, and this gate is what makes
          // that exclusion real at runtime rather than only in the catalog.
          ...buildWorktreeMastraTools(runtimeData, dependencies.worktreeTools),
        }),
```

Pin the gate in `apps/desktop/src/__tests__/assistant-server/assistant-tools-multiroot-and-gating.integration.test.ts`, beside the existing local-provider cases:

```ts
  it('omits both worktree tools for the built-in local provider', () => {
    // `{ provider } as RuntimeData` is the file's convention (see the
    // manageTaskList gating cases at ~L493-509).
    const tools = buildDesktopAssistantTools({ provider: 'local' } as RuntimeData, {});

    expect(Object.hasOwn(tools, NATIVE_TOOL_ID.listWorktrees)).toBe(false);
    expect(Object.hasOwn(tools, NATIVE_TOOL_ID.manageWorktree)).toBe(false);
    // Falsifier: the gate must not have swallowed its neighbours either.
    expect(Object.hasOwn(tools, NATIVE_TOOL_ID.readWorkspaceFile)).toBe(true);
  });

  it('registers both worktree tools for a hosted provider', () => {
    const tools = buildDesktopAssistantTools({ provider: 'openai' } as RuntimeData, {});

    expect(Object.hasOwn(tools, NATIVE_TOOL_ID.listWorktrees)).toBe(true);
    expect(Object.hasOwn(tools, NATIVE_TOOL_ID.manageWorktree)).toBe(true);
  });
```

- [ ] **Step 5: Build the capability where the run id lives**

`apps/desktop/src/assistant-server/server-options.ts`:

```ts
/**
 * Lazily resolved because `main.ts` constructs the WorktreeService at
 * `app.whenReady()` while the assistant server starts from the same phase —
 * the same laziness `worktrees-ipc-handlers.ts` uses for its `resolveService`.
 */
export interface AssistantServerOptions {
  …
  resolveWorktreeService?: (() => WorktreeService | null) | undefined;
}
```

`apps/desktop/src/assistant-server.ts`, in the request handler that already has `core.runId` in scope:

```ts
          toolDependencies: {
            embeddingHostManager: options.embeddingHostManager,
            llmHostManager: options.llmHostManager,
            ...buildWorktreeToolDependency(options, core),
          },
```

```ts
/**
 * `createdBy: 'agent'` and the run/thread ids are bound HERE, never taken from
 * tool input: provenance the model can set is provenance the model can forge.
 */
function buildWorktreeToolDependency(
  options: AssistantServerOptions,
  core: { readonly runId?: string; readonly runtimeData?: RuntimeData }
): { worktreeTools?: WorktreeToolCapability } {
  const service = options.resolveWorktreeService?.() ?? null;
  if (!service) {
    return {};
  }
  const runId = core.runId;
  const threadId = core.runtimeData?.memory?.threadId;
  return {
    worktreeTools: {
      archive: (params) =>
        service.archive({ ...params, ...(runId ? { runId } : {}) }),
      create: (params) =>
        service.create({
          ...params,
          branch: { name: params.branch },
          createdBy: 'agent',
          ...(runId ? { runId } : {}),
          ...(threadId ? { threadId } : {}),
        }),
      list: () => service.list(),
    },
  };
}
```

`apps/desktop/src/main.ts`, at the `startAssistantServer` call:

```ts
          resolveWorktreeService: () => worktreeService,
```

- [ ] **Step 6: Update the registry-parity fixture**

This suite asserts, for a HOSTED runtime, that `Object.keys(tools).sort()` equals `[...DESKTOP_NATIVE_TOOL_IDS].sort()` and that each tool's `description`/`inputSchema` are IDENTITY-equal to the catalog's. With both ids registered inside the hosted branch of the local-provider gate that assertion holds unchanged; add the two ids to the suite's own hardcoded expected-id array (it keeps one — see the parity fixture edits in Task 8), and keep the two gate cases from Step 4 beside it.

- [ ] **Step 7: Pay the prompt-budget ledger**

`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts` — four edits, in this order:

1. Add a ledger paragraph in the header comment, in the BST-1173 format, recording the measured move **and answering the trim question explicitly**:

```
// BST-1392 RAISE (+<measured>/+<measured>, band width 300 preserved).
// `listWorktrees` and `manageWorktree` are a NEW isolated-checkout capability
// for the agent: the one-field listing costs ~<measured> authored definition
// tokens and the seven-field management envelope ~<measured>, moving the
// measured full hosted surface <before> → <after>.
//
// TRIM CONSIDERED AND REJECTED — no existing definition is paying for
// something this capability makes redundant, so this is a RAISE, not a
// rebalance, and the trade is stated rather than hidden:
//   * `brainstrike.executeCommand` cannot be trimmed: it is critical-tier and
//     the correlator in W5 Layer 4 depends on it running unchanged.
//   * No other tool overlaps worktree management; the nearest neighbour,
//     `manageCanvas`, addresses a different store entirely.
//   * The trim that WAS taken is structural: spec §6.4 named three tools
//     (createWorktree/listWorktrees/archiveWorktree) and this ships two, with
//     the mutations sharing one action envelope — roughly one tool definition
//     saved against the literal reading of the spec.
// If the raise pushes the aggregate band, do NOT widen the band: re-open the
// two-vs-three decision, or defer `manageWorktree` to a follow-up and ship the
// read-only listing first.
```

**Rule for whoever executes this step:** the ledger paragraph must name a real trim candidate or state that none exists. "Raised the bound" with no reasoning is exactly the drift the ledger was built to stop.

2. `eagerToolCount: 39,` (37 → 39).
3. Both aggregate band bounds moved by the SAME delta so the 300-token band width is preserved.
4. A per-tool definition pin for `manageWorktree`, mirroring the `manageCanvas` finder.

Run the test FIRST to read the actual numbers out of its failure message; never guess them.

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/native-tool-prompt-budget.test.ts
```

- [ ] **Step 8: Run every affected lane and commit**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server
pnpm run type-check
pnpm run lint:eslint
pnpm dlx ultracite fix apps/desktop/src/assistant-server apps/desktop/src/assistant-server.ts apps/desktop/src/main.ts
pnpm dlx ultracite check apps/desktop/src/assistant-server/assistant-tools.ts
git add -A
git commit -m "feat(BST-1392): agent worktree tools over the one worktree service

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---
# Layer 4 — Shell-output correlation

**Branch:** `seandearnaley/bst-1392-w5-shell-correlation` (stacked on Layer 3 — both edit `assistant-tools.ts` and `DesktopAssistantToolDependencies`, so this layer is STRICTLY after Layer 3)

```bash
gh stack add seandearnaley/bst-1392-w5-shell-correlation
```

---

### Task 11: The pure scanner

**Files:**
- Create: `packages/assistant-contract/src/shell-git-correlation.ts`
- Create: `packages/assistant-contract/src/__tests__/shell-git-correlation.test.ts`
- Modify: `packages/assistant-contract/src/index.ts`

**Interfaces:**
```ts
export interface ShellGitCorrelationSignals {
  readonly createdPullRequest: boolean;
  readonly touchedWorktrees: boolean;
}
export function scanShellCommandForGitSignals(command: string): ShellGitCorrelationSignals;
```

**What it is and is not:** a cheap TRIGGER, not a parser. It answers "is it worth asking git what actually changed", and nothing downstream trusts anything it extracts — the reconciler re-reads the real inventory. That is why it does not try to pull a path out of `git worktree add "$DIR/$(date +%s)"`, and why a false positive costs one inventory read.

- [ ] **Step 1: Write the failing test**

Create `packages/assistant-contract/src/__tests__/shell-git-correlation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scanShellCommandForGitSignals } from '../shell-git-correlation';

describe('scanShellCommandForGitSignals', () => {
  it.each([
    'git worktree add ../wt -b feature',
    'git worktree remove ../wt',
    'cd /repo && git worktree add "$DIR"',
    'git   worktree\tadd ../wt',
    'git -C /repo worktree add ../wt',
    'pnpm build; git worktree prune',
  ])('flags %s as touching worktrees', (command) => {
    expect(scanShellCommandForGitSignals(command).touchedWorktrees).toBe(true);
  });

  it.each([
    'git status',
    'git log --oneline worktree',
    'echo "git worktree add" >> notes.md',
    'rg "worktree add" src',
  ])('does not flag %s', (command) => {
    expect(scanShellCommandForGitSignals(command).touchedWorktrees).toBe(false);
  });

  it.each(['gh pr create --fill', 'gh  pr   create -t x', 'cd /repo && gh pr create --draft'])(
    'flags %s as creating a pull request',
    (command) => {
      expect(scanShellCommandForGitSignals(command).createdPullRequest).toBe(true);
    }
  );

  it.each(['gh pr view', 'gh pr list', 'gh issue create'])('does not flag %s', (command) => {
    expect(scanShellCommandForGitSignals(command).createdPullRequest).toBe(false);
  });

  it('flags both signals independently in one command', () => {
    expect(scanShellCommandForGitSignals('git worktree add ../wt && gh pr create --fill')).toEqual({
      createdPullRequest: true,
      touchedWorktrees: true,
    });
  });

  it('is bounded: only the first 16 KiB of a command is scanned', () => {
    const padded = `${'x'.repeat(20_000)} git worktree add ../wt`;
    expect(scanShellCommandForGitSignals(padded).touchedWorktrees).toBe(false);
  });

  it('returns both false for an empty command instead of throwing', () => {
    expect(scanShellCommandForGitSignals('')).toEqual({
      createdPullRequest: false,
      touchedWorktrees: false,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the scanner**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run src/__tests__/shell-git-correlation.test.ts
```

Create `packages/assistant-contract/src/shell-git-correlation.ts`:

```ts
/**
 * Shell-command TRIGGER scan for the worktree/PR correlator (BST-1392, spec
 * §6.4). Pure, bounded, and deliberately conservative in what it CLAIMS.
 *
 * It answers one question — "is it worth asking git and the forge what actually
 * changed" — and nothing downstream trusts it for anything else. It extracts no
 * path and no PR number: `git worktree add "$DIR/$(date +%s)"` is unparseable
 * in principle, so the reconciler re-reads the real inventory instead. A false
 * positive therefore costs one inventory read; a false negative costs a
 * timeline breadcrumb, which the ledger's own row and the Map still show.
 *
 * The scan window mirrors `run-verdict.ts`'s discipline: bounded input, no
 * excerpt of the command ever reaches a log or a run event.
 */

/** Documented scan bound: the leading 16 KiB (UTF-16 code units) of the command. */
export const SHELL_CORRELATION_SCAN_CHARS = 16 * 1024;

export interface ShellGitCorrelationSignals {
  readonly createdPullRequest: boolean;
  readonly touchedWorktrees: boolean;
}

// `git [-C <path>|-c k=v|--<flag>]* worktree <add|remove|prune|move>`, anchored
// at a command boundary (start, `;`, `&&`, `||`, `|`, or a newline) so a
// `worktree add` inside an echoed string or an `rg` pattern never matches.
const GIT_WORKTREE_RE =
  /(?:^|[\n;|&])\s*(?:[A-Za-z_][\w]*=\S*\s+)*git(?:\s+(?:-C\s+\S+|-c\s+\S+|--\S+))*\s+worktree\s+(?:add|move|prune|remove)\b/u;

// `gh pr create` only. `gh pr view`/`list` observe, they do not create.
const GH_PR_CREATE_RE = /(?:^|[\n;|&])\s*(?:[A-Za-z_][\w]*=\S*\s+)*gh\s+pr\s+create\b/u;

export function scanShellCommandForGitSignals(command: string): ShellGitCorrelationSignals {
  const window = command.slice(0, SHELL_CORRELATION_SCAN_CHARS);
  return {
    createdPullRequest: GH_PR_CREATE_RE.test(window),
    touchedWorktrees: GIT_WORKTREE_RE.test(window),
  };
}
```

Export it from `packages/assistant-contract/src/index.ts`:

```ts
export * from './shell-git-correlation.js';
```

- [ ] **Step 3: Run it to verify it passes, then commit**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run
pnpm dlx ultracite fix packages/assistant-contract/src/shell-git-correlation.ts packages/assistant-contract/src/index.ts
git add packages/assistant-contract
git commit -m "feat(BST-1392): pure shell-command trigger scan for git/gh signals

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: The correlator — reconcile the ledger, breadcrumb the run, refresh the forge

**Files:**
- Create: `apps/desktop/src/assistant-server/shell-worktree-correlation.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/shell-worktree-correlation.test.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-adopt.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/assistant-server/assistant-tools.ts`
- Modify: `apps/desktop/src/assistant-server/server-options.ts`, `apps/desktop/src/assistant-server.ts`, `apps/desktop/src/main.ts`
- Modify: `packages/types/src/forge.ts`, `apps/desktop/src/assistant-server/forge-service.ts`, `apps/desktop/src/forge-ipc-handlers.ts`, `packages/app-shell/src/forge/forge-bridge.ts`

**Interfaces:**
```ts
// worktree-adopt.ts
export interface WorktreeShellReconcileResult {
  readonly adopted: readonly ManagedWorktreeRow[];
  readonly vanishedLedgerIds: readonly string[];
}
export function reconcileWorktreesFromShell(
  deps: WorktreeAdoptDeps,
  params: { readonly repoCommonDir: string; readonly runId?: string; readonly threadId?: string }
): Promise<GitResult<WorktreeShellReconcileResult>>;

// shell-worktree-correlation.ts
export interface ShellCorrelationCapability {
  readonly onCommandCompleted: (input: {
    readonly command: string;
    readonly rootId: string;
  }) => void;
}
export function createShellCorrelation(deps: {
  readonly forgeRefresh: (rootId: string) => void;
  readonly logger?: Logger;
  readonly reconcile: (rootId: string) => Promise<GitResult<WorktreeShellReconcileResult>>;
}): ShellCorrelationCapability;
```

- [ ] **Step 1: Add the `shell` refresh reason [A8]**

`packages/types/src/forge.ts`:

```ts
/** Which RENDERER event asked for a refresh. Each carries its own minimum interval. */
export type ForgeRendererRefreshReason = 'invalidation' | 'user' | 'window';

/**
 * Every reason the SERVICE accepts. `'shell'` is main-only: it is raised by the
 * shell-output correlator when the agent's own command ran `gh pr create`, a
 * event that moves no ref and therefore never reaches the git-metadata watcher.
 * It is deliberately NOT part of {@link ForgeRendererRefreshReason} — a
 * renderer claiming it would be claiming an observation it cannot have made.
 */
export type ForgeRefreshReason = ForgeRendererRefreshReason | 'shell';
```

`apps/desktop/src/assistant-server/forge-service.ts` — the floors map is `Record<ForgeRefreshReason, number>` and so fails to compile until `shell` is added:

```ts
export const FORGE_REFRESH_MIN_INTERVAL_MS: Readonly<Record<ForgeRefreshReason, number>> = {
  invalidation: 0,
  // A `gh pr create` we just watched happen is the freshest possible trigger.
  shell: 0,
  user: 0,
  window: 60_000,
};
```

`apps/desktop/src/forge-ipc-handlers.ts` — pin the validator to the RENDERER union so `shell` stays unreachable from the wire:

```ts
const REFRESH_REASONS = {
  invalidation: true,
  user: true,
  window: true,
} as const satisfies Record<ForgeRendererRefreshReason, true>;
```

`packages/app-shell/src/forge/forge-bridge.ts` — `refresh` takes `ForgeRendererRefreshReason`.

Add a falsifying case to `apps/desktop/src/__tests__/forge-ipc-handlers.test.ts`:

```ts
  it('refuses a renderer-supplied "shell" refresh reason', async () => {
    const result = await handlers.refresh({ reason: 'shell', rootId: 'root-1' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('"invalidation", "user" or "window"');
    expect(service.refresh).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Write the failing reconciler test**

Append to `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`:

```ts
describe('reconcileWorktreesFromShell', () => {
  it('adopts every on-disk worktree of the repository that has no live ledger row', async () => {
    const inserted: ManagedWorktreeRow[] = [];
    const deps = {
      ledger: {
        getByPath: vi.fn(async (target: string) =>
          target === '/repo/known'
            ? ({ archivedAt: null, id: 'known-1', path: '/repo/known' } as never)
            : null
        ),
        insert: vi.fn(async (row: ManagedWorktreeRow) => {
          inserted.push(row);
          return row;
        }),
        listActive: vi.fn(async () => [
          { id: 'known-1', path: '/repo/known', repoCommonDir: '/repo/.git' } as never,
          { id: 'gone-1', path: '/repo/gone', repoCommonDir: '/repo/.git' } as never,
        ]),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () =>
        Promise.resolve(inventory([{ path: '/repo' }, { path: '/repo/known' }, { path: '/repo/new' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(async () => ({ exitCode: 0, signal: null, stderr: '', stdout: 'deadbeef\n' })),
    };

    const result = await reconcileWorktreesFromShell(deps, {
      repoCommonDir: '/repo/.git',
      runId: 'run-1',
      threadId: 'thread-1',
    });

    expect(result.ok).toBe(true);
    // Only the NEW linked worktree is adopted: the primary checkout is not a
    // managed worktree, and the known one already has a row.
    expect(inserted.map((row) => row.path)).toEqual(['/repo/new']);
    expect(inserted[0]?.createdBy).toBe('agent');
    expect(inserted[0]?.runId).toBe('run-1');
    expect(inserted[0]?.threadId).toBe('thread-1');
    expect(result.ok && result.value.adopted).toHaveLength(1);
  });

  it('reports ledger rows that vanished from disk without archiving or deleting them', async () => {
    const deps = {
      ledger: {
        getByPath: vi.fn(async () => null),
        insert: vi.fn(),
        listActive: vi.fn(async () => [
          { id: 'gone-1', path: '/repo/gone', repoCommonDir: '/repo/.git' } as never,
        ]),
      } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(inventory([{ path: '/repo' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run: vi.fn(),
    };

    const result = await reconcileWorktreesFromShell(deps, { repoCommonDir: '/repo/.git' });

    expect(result.ok && result.value.vanishedLedgerIds).toEqual(['gone-1']);
    // A `git worktree remove` in a shell is NOT an archive: there is no
    // snapshot, so pretending it was one would make `restore` promise
    // something it cannot deliver. The ghost row is the honest surface.
    expect(deps.ledger.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Write the reconciler**

Append to `apps/desktop/src/assistant-server/worktree-adopt.ts`:

```ts
export interface WorktreeShellReconcileResult {
  readonly adopted: readonly ManagedWorktreeRow[];
  /**
   * Live ledger rows whose directory is no longer on disk. Reported, NOT
   * archived: an archive carries a restorable snapshot, and a `git worktree
   * remove` run in a shell produced none. `list()` already renders these as
   * ghost rows reading "missing on disk — restore it or archive it", which is
   * the honest surface for a removal the app did not perform.
   */
  readonly vanishedLedgerIds: readonly string[];
}

/**
 * Re-derive the ledger for ONE repository after the agent's shell touched
 * worktrees (spec §6.4). Nothing here trusts the command text: the live
 * inventory is the authority for what exists, so an unparseable
 * `git worktree add "$DIR/$(date +%s)"` reconciles exactly as well as a literal
 * path would.
 */
export async function reconcileWorktreesFromShell(
  deps: WorktreeAdoptDeps,
  params: {
    readonly repoCommonDir: string;
    readonly runId?: string;
    readonly threadId?: string;
  }
): Promise<GitResult<WorktreeShellReconcileResult>> {
  const inventory = await deps.resolveInventory();
  const repository = inventory.repositories.find(
    (candidate) => candidate.identity.gitCommonDir === params.repoCommonDir
  );
  if (!repository) {
    return {
      error: `No repository with common dir "${params.repoCommonDir}" is in the workspace inventory.`,
      ok: false,
    };
  }
  const onDiskPaths = new Set(repository.worktrees.map((descriptor) => descriptor.path));
  const activeRows = await deps.ledger.listActive();
  const vanishedLedgerIds = activeRows
    .filter((row) => row.repoCommonDir === params.repoCommonDir && !onDiskPaths.has(row.path))
    .map((row) => row.id);

  const adopted: ManagedWorktreeRow[] = [];
  for (const descriptor of repository.worktrees) {
    // The primary checkout is not a managed worktree; adopting it would put
    // the user's own clone under archive/restore machinery.
    if (descriptor.path === repository.identity.repositoryRoot) {
      continue;
    }
    const result = await adoptWorktree(deps, {
      createdBy: 'agent',
      path: descriptor.path,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
    });
    if (result.ok) {
      adopted.push(result.value);
      continue;
    }
    // Already managed, unreachable, or unvalidated: each is a legitimate
    // outcome of a best-effort reconcile, so it is logged, not surfaced as a
    // failure of the whole pass.
    logger.debug('shell reconcile skipped a worktree', {
      path: descriptor.path,
      reason: result.error,
    });
  }
  return { ok: true, value: { adopted, vanishedLedgerIds } };
}
```

Expose it on the service under the mutex, emitting the `via: 'shell'` breadcrumb per adopted row:

```ts
    async reconcileFromShell(params: {
      readonly repoCommonDir: string;
      readonly runId?: string;
      readonly threadId?: string;
    }): Promise<GitResult<WorktreeShellReconcileResult>> {
      return await serialize(async () => {
        try {
          const reconciled = await reconcileWorktreesFromShell(adoptDeps(), params);
          if (reconciled.ok) {
            for (const row of reconciled.value.adopted) {
              await emitWorktreeShellCreatedEvent(deps, params.runId ?? null, row);
            }
          }
          return reconciled;
        } catch (error) {
          logger.error('worktree shell reconcile failed', { error, ...params });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
```

…with the emitter in `worktree-run-events.ts` (the SAME `worktree.created` kind — A4 — so the pairing contract is untouched):

```ts
/** `worktree.created` for a worktree the AGENT made in a shell (spec §6.4). */
export async function emitWorktreeShellCreatedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow
): Promise<void> {
  await emit(deps, runId, 'worktree.created', () => ({
    detail: worktree.branch ?? 'detached HEAD',
    // "via shell" in the label, not just the metadata: the timeline must say
    // out loud that BrainStrike did not perform this operation, it observed it.
    label: `Agent created worktree ${path.basename(worktree.path)} (via shell)`,
    metadata: {
      branch: worktree.branch,
      path: worktree.path,
      via: 'shell',
      worktreeId: worktree.id,
    },
    status: 'info',
  }));
}
```

`adoptDeps()` is a tiny private helper in `worktree-service.ts` returning the `WorktreeAdoptDeps` literal that Tasks 2 and 3 already build inline — extract it there so the three call sites share one construction and the file gains no net lines.

- [ ] **Step 4: Write the failing correlator test**

Create `apps/desktop/src/__tests__/assistant-server/shell-worktree-correlation.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createShellCorrelation } from '../../assistant-server/shell-worktree-correlation';

function harness() {
  const forgeRefresh = vi.fn();
  const reconcile = vi.fn().mockResolvedValue({ ok: true, value: { adopted: [], vanishedLedgerIds: [] } });
  return { correlation: createShellCorrelation({ forgeRefresh, reconcile }), forgeRefresh, reconcile };
}

describe('createShellCorrelation', () => {
  it('reconciles when the command touched worktrees, and does not touch the forge', async () => {
    const { correlation, forgeRefresh, reconcile } = harness();

    correlation.onCommandCompleted({ command: 'git worktree add ../wt -b x', rootId: 'root-1' });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    expect(reconcile).toHaveBeenCalledWith('root-1');
    expect(forgeRefresh).not.toHaveBeenCalled();
  });

  it('refreshes the forge when the command created a pull request, and does not reconcile', async () => {
    const { correlation, forgeRefresh, reconcile } = harness();

    correlation.onCommandCompleted({ command: 'gh pr create --fill', rootId: 'root-1' });
    await vi.waitFor(() => expect(forgeRefresh).toHaveBeenCalledTimes(1));

    expect(forgeRefresh).toHaveBeenCalledWith('root-1');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does nothing at all for an unrelated command', async () => {
    const { correlation, forgeRefresh, reconcile } = harness();

    correlation.onCommandCompleted({ command: 'pnpm test', rootId: 'root-1' });
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();
    expect(forgeRefresh).not.toHaveBeenCalled();
  });

  it('never lets a reconcile failure escape into the tool call', async () => {
    const forgeRefresh = vi.fn();
    const reconcile = vi.fn().mockRejectedValue(new Error('boom'));
    const correlation = createShellCorrelation({ forgeRefresh, reconcile });

    expect(() =>
      correlation.onCommandCompleted({ command: 'git worktree add ../wt', rootId: 'root-1' })
    ).not.toThrow();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 5: Write the correlator**

Create `apps/desktop/src/assistant-server/shell-worktree-correlation.ts`:

```ts
/**
 * Shell-output correlation (BST-1392, spec §6.4): when the agent's own
 * `executeCommand` ran `git worktree …` or `gh pr create`, ask the authorities
 * what actually changed.
 *
 * BEST-EFFORT AND FIRE-AND-FORGET, on purpose. It runs AFTER the tool result
 * exists and never blocks, delays or fails the tool call — a breadcrumb must
 * not be able to break the thing it describes. Every failure is logged with
 * identity only; the command text never reaches a log or a run event.
 *
 * It correlates from the TOOL RESULT, never from the git-metadata watcher: that
 * signal carries only `{ gitCommonDir, repositoryRoot }` with no
 * create-vs-remove discrimination and a 300–2000 ms coalescing window, so
 * attributing it to a run would be a temporal guess. See
 * docs/agents/assistant-persistence.md.
 */
import { scanShellCommandForGitSignals } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { GitResult } from '@brainstrike/types';
import type { WorktreeShellReconcileResult } from './worktree-adopt';

const logger = createLogger('ShellWorktreeCorrelation');

export interface ShellCorrelationCapability {
  readonly onCommandCompleted: (input: {
    readonly command: string;
    readonly rootId: string;
  }) => void;
}

export function createShellCorrelation(deps: {
  readonly forgeRefresh: (rootId: string) => void;
  readonly reconcile: (rootId: string) => Promise<GitResult<WorktreeShellReconcileResult>>;
}): ShellCorrelationCapability {
  return {
    onCommandCompleted: ({ command, rootId }) => {
      const signals = scanShellCommandForGitSignals(command);
      if (signals.touchedWorktrees) {
        void deps
          .reconcile(rootId)
          .then((result) => {
            if (result.ok) {
              logger.info('shell worktree reconcile completed', {
                adopted: result.value.adopted.length,
                rootId,
                vanished: result.value.vanishedLedgerIds.length,
              });
              return;
            }
            logger.warn('shell worktree reconcile refused', { reason: result.error, rootId });
          })
          .catch((error: unknown) => {
            logger.error('shell worktree reconcile threw', { error, rootId });
          });
      }
      if (signals.createdPullRequest) {
        try {
          deps.forgeRefresh(rootId);
        } catch (error) {
          logger.error('shell forge refresh threw', { error, rootId });
        }
      }
    },
  };
}
```

- [ ] **Step 6: Hook it onto `executeCommand`**

`apps/desktop/src/assistant-server/assistant-tools.ts` — the dependency field beside `worktreeTools`:

```ts
  /**
   * Request-scoped shell correlation (BST-1392). Absent ⇒ no correlation, which
   * is the honest degradation for a session with no worktree/forge service:
   * the command still runs and its result is unchanged.
   */
  shellCorrelation?: ShellCorrelationCapability | undefined;
```

…and inside the existing `executeCommand` registration's `try`, immediately after the result is in hand — three added lines, no restructuring:

```ts
      try {
        const result = await runExecuteCommand(resolvedInput, runtimeData, {
          signal: options?.abortSignal,
          ...(stream ? { stream } : {}),
        });
        // Fire-and-forget: the correlator never awaits, never throws into the
        // tool call, and reads only the MODEL-SUPPLIED command plus the
        // result's own resolved rootId.
        dependencies.shellCorrelation?.onCommandCompleted({
          command: resolvedInput.command,
          rootId: result.rootId,
        });
        return result;
      } catch (error) {
```

> Scan `resolvedInput.command`, NOT `result.command`: the result echoes only the first 200 characters (`MAX_ECHOED_COMMAND_CHARS`), so a `git worktree add` later in a chain would be invisible.

`apps/desktop/src/assistant-server.ts` — build the capability alongside the worktree one, in the same `buildWorktreeToolDependency` scope, closing over `core.runId` / `threadId` and the two lazily resolved services:

```ts
  const service = options.resolveWorktreeService?.() ?? null;
  const forge = options.resolveForgeService?.() ?? null;
  …
    shellCorrelation:
      service || forge
        ? createShellCorrelation({
            forgeRefresh: (rootId) => {
              void forge?.refresh(rootId, 'shell');
            },
            reconcile: async (rootId) => {
              const context = await service?.repositoryContextForRoot(rootId);
              if (!context?.ok) {
                return context ?? { error: 'Worktrees are unavailable in this session.', ok: false };
              }
              return await service.reconcileFromShell({
                repoCommonDir: context.value.commonDir,
                ...(runId ? { runId } : {}),
                ...(threadId ? { threadId } : {}),
              });
            },
          })
        : undefined,
```

`repositoryContextForRoot` is a thin public wrapper around `worktree-service.ts`'s existing private `resolveRepositoryContext` — export it on the service object rather than duplicating the two `rev-parse` calls.

`apps/desktop/src/main.ts` adds `resolveForgeService: () => forgeService ?? null` beside `resolveWorktreeService`.

- [ ] **Step 7: Run everything this layer touched**

```bash
pnpm --filter @brainstrike/assistant-contract vitest run
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server src/__tests__/forge-ipc-handlers.test.ts
pnpm --filter @brainstrike/desktop test:integration -- src/__tests__/assistant-server/worktree-adopt.integration.test.ts
pnpm --filter @brainstrike/app-shell vitest run src/__tests__ src/worktree-map
pnpm run type-check
pnpm run lint:eslint
```

Expected: green throughout. The forge bridge's narrowed `refresh` reason type fails to compile at every renderer call site that passed a wider type — fix the call sites, never widen the bridge back.

- [ ] **Step 8: Commit and submit**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server apps/desktop/src/assistant-server.ts apps/desktop/src/main.ts apps/desktop/src/forge-ipc-handlers.ts packages/types/src/forge.ts packages/app-shell/src/forge/forge-bridge.ts
pnpm dlx ultracite check apps/desktop/src/assistant-server/assistant-tools.ts apps/desktop/src/assistant-server/worktree-service.ts apps/desktop/src/assistant-server/worktree-adopt.ts
git add -A
git commit -m "feat(BST-1392): correlate agent shell output to worktrees and pull requests

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 5 — End-to-end coverage, live verification and docs

**Branch:** `seandearnaley/bst-1392-w5-verification` (stacked on Layer 4)

```bash
gh stack add seandearnaley/bst-1392-w5-verification
```

---

### Task 13: Desktop E2E

**Files:**
- Create: `apps/desktop/e2e/worktree-map.desktop.test.ts`
- Modify: `apps/desktop/e2e/utils/git-fixtures.ts` (reuse `freshRepoWithExternalWorktree`, added in W3)

The suite drives the BUILT Electron app against real on-disk repositories and the real PGlite ledger; only assistant model traffic is replaced at its external boundary (`setupAssistantMock`), and `gh` is replaced by W4's PATH shim (`apps/desktop/e2e/utils/gh-shim.ts`).

> **[CORRECTION — Task 13 execution, Layer 5]** "replaced at its external boundary" was true only in intent for `setupAssistantMock`. In reality `setupAssistantMock` overrides `fetch` inside the RENDERER and fully replaces any `/assistant`-prefixed POST response — that is the app's own INTERNAL endpoint (Electron main's local HTTP server), one hop short of the true external boundary (the model provider's API). Because native tools are registered server-side into the Mastra agent inside that same request/response cycle, a test using `setupAssistantMock` can drive the Map UI and any DIRECT UI-initiated action (e.g. the create-worktree dialog), but can NEVER exercise real native-tool execution (`brainstrike.manageWorktree`, `brainstrike.executeCommand`) — the real assistant server is never reached, so the real Mastra loop and real `execute()` functions never run. Cases 4-5 (agent-provenance and shell-correlation) need exactly that real execution, so they use a NEW, narrower mock: `apps/desktop/e2e/utils/model-provider-shim.ts`, a real local HTTP server that redirects the provider's OWN outbound call via `OPENROUTER_BASE_URL` (an existing production config knob, `openrouter-strict-content.ts`'s `buildUrl()`) — this is what actually realizes the "external boundary" contract this paragraph describes. `setupAssistantMock` remains correct and unchanged for Cases 1-3, whose only need is satisfying the composer's assistant-availability precondition. See the suite file's own header for the full mechanism-per-case breakdown.

- [ ] **Step 1: Write the suite**

Follow `apps/desktop/e2e/worktree-mode.desktop.test.ts` verbatim for the fixture scaffolding (`createTempDirTracker`, `seedRoot`, `ensureAssistantShellVisible`, the realpath'd `managedDirectory`). Five cases, each asserting a COMPUTED fact:

1. **The tab exists and lists every checkout.** Seed a repo that has a primary checkout plus an external `.claude/worktrees/x` worktree (`freshRepoWithExternalWorktree`). Open the "+" menu, click `Worktrees`, and assert `page.getByTestId('worktree-map-card')` has count 2, that the first card contains the repository name and the text `Primary checkout`, and that the second contains `Claude Code`.
2. **The primary checkout is refused as a checkout target.** Assert the primary card's `worktree-map-new-thread` button is `disabled` and its `title` is exactly `"This is the repository's primary checkout — use Hand off to Local instead."`.
3. **Adoption from the Map binds a thread.** **Corrected at Task 3/6 execution** — the external card's `New thread here` is DISABLED until adopted (`disabled={!entry.usable}`; an unmanaged row is never `usable`), so this case drives the actions menu's `Adopt` item, not `New thread here`, first. Open the external worktree card's actions menu (`worktree-map-card-actions`) and click `Adopt`; assert `worktrees:adopt` produced exactly one live `brainstrike_worktrees` row for that path via the `window.electronAPI.db.query` bridge, and that the card's `New thread here` button becomes enabled once the invalidation-driven refresh lands. THEN click `New thread here` on that now-adopted card and assert the composer's `workspace-bar-mode-chip` ends up containing the worktree's directory name (timeout 90 s — mounting the root and reconciling `roots` is the slow part, not the adopt call itself).
4. **The agent tool creates a worktree with agent provenance.** Drive `setupAssistantMock` with a scripted `brainstrike.manageWorktree` `create` call, approve the permission prompt, and assert (a) the Map gains a card for the new branch after the invalidation lands, and (b) `SELECT created_by, run_id FROM brainstrike_worktrees WHERE path = $1` returns `('agent', <non-null>)`.
5. **Shell correlation adopts what the agent's shell made.** Script an `executeCommand` call whose command is a real `git worktree add`; after the tool completes, assert a `brainstrike_worktrees` row exists for the new path with `created_by = 'agent'` and a non-null `run_id`, and that a `brainstrike_assistant_run_events` row exists with `kind = 'worktree.created'` and `metadata->>'via' = 'shell'`.

Case 5 is the one that would silently pass if the correlator were wired to the watcher instead of the tool result, so it asserts the `via` metadata explicitly rather than only the ledger row.

- [ ] **Step 2: Run it non-interactively**

```bash
pnpm --filter @brainstrike/desktop build
pnpm --filter @brainstrike/desktop e2e -- worktree-map.desktop.test.ts
```

Expected: 5 passed. A headless flake is diagnosed, never bypassed — check `docs/agents/ci-quality.md`'s desktop-E2E notes and the stale-geometry-lock gotcha before re-running.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/e2e
git commit -m "test(BST-1392): desktop e2e for the Worktree Map, adoption and correlation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: CDT verification and the in-band docs pass

**Files:**
- Create: `scripts/probe-worktree-map.mjs`
- Modify: `docs/agents/changeset-diff.md`, `docs/agents/workspace-context.md`, `docs/agents/assistant-providers.md`, `docs/agents/assistant-persistence.md`, `packages/agent/AGENTS.md`

- [ ] **Step 1: Write the CDT probe**

`scripts/probe-worktree-map.mjs` attaches to the agent-debug renderer (`pnpm --filter @brainstrike/desktop dev:agent-debug`, port 9222) and prints, as JSON:

- `cardCount`, and per card: `name`, `provenanceLabel`, `branchLabel`, the `aria-label` of every glyph, `newThreadDisabled`, `newThreadTitle`, `indexingBadgeText`, `prPillText`.
- `laneScrollWidth` vs `laneClientWidth` for each repository lane, and `document.body.scrollWidth === document.body.clientWidth`.
- The computed `background-color` and `color` of one card in light and dark, to confirm the surface uses tokens rather than hard-coded colors.

- [ ] **Step 2: Run the consolidated live verification**

Definition of done for the whole PR stack. Report COMPUTED VALUES:

1. Zero worktrees → the empty state reads exactly `"No worktrees yet — create one from the composer's Mode chip."` and no card element exists.
2. One repository with a primary + two worktrees → `cardCount === 3`, the primary card is FIRST in DOM order, and its `newThreadDisabled === true`.
3. A locked worktree → its card renders the `Locked: …` reason text and `newThreadDisabled === true` with that text as the `title`.
4. A worktree with an open PR → the PR pill's text matches `#\d+` and the rollup glyph agrees with the thread-list pill for the same branch (assert the two strings are equal — this is the "cannot disagree" claim from A2, verified rather than asserted).
5. Kill `gh` on PATH and reload → the pill is absent and the BranchChip's W4 diagnostic states the reason; the Map still renders every card.
6. Toggle the indexing badge → `worktreeRootIndexingOptInById` in the persisted store gains the durable `roots.id`, and the badge text flips to `Indexing enabled`.
7. Narrow the pane below the container-query breakpoint → the lane scrolls (`laneScrollWidth > laneClientWidth`) and `document.body.scrollWidth === document.body.clientWidth`.

- [ ] **Step 3: Update the architecture docs in-band**

`docs/agents/changeset-diff.md` — extend the worktree section:

```md
### WORKTREE MAP + ADOPTION (BST-1392)

`WorktreeListEntry` carries `primary`, `repoCommonDir` and `createdAt` so one
`worktrees.list()` can drive both the Mode chip's picker and the Worktree Map.
`primary` is `descriptor.path === repository.identity.repositoryRoot`; a primary
row is deliberately `usable: false` with a stated reason, because a thread that
operates in the user's own clone is in LOCAL mode by definition and binding
`checkoutMode: 'worktree'` to it would produce a checkout hand-off could not
leave. `repoCommonDir` — not `repositoryRoot` — is the key `brainstrike_forge_prs`
joins on, so the Map's PR pill and the thread list's PR pill cannot disagree.

`worktrees.adopt` records an EXISTING on-disk worktree in the ledger. It refuses
a path that is outside every granted root AND outside the managed directory:
`resolveUsability` treats "has a ledger row" as authorization, so an
unreachable adopted row would read `usable: true` while every operation on it
failed. It also refuses the repository's own primary checkout, mirroring the
picker's primary gate. `base_ref` is the worktree's HEAD at adoption time —
"unpushed" for an adopted worktree means "committed here since BrainStrike
started managing it". The Mode chip's picker never calls it — every unmanaged
row is `usable: false`, so its select button is always disabled, which makes
adopting through the picker structurally unreachable. The Worktree Map card's
`Adopt` action is the only UI caller; the agent tool is the only other one.

`worktrees.checkoutStatus` is a LAZY, per-checkout `git status --porcelain=v2
--branch -z` parsed by the production `parsePorcelainV2Z`. It is deliberately
not folded into `list()`, which backs the picker and refreshes on every
invalidation; N status subprocesses behind an orientation surface is the cost
this seam exists to avoid. Until a card's status resolves it renders
"checking…", never a clean glyph.

**"Open in Terminal" is deferred to W6 — settled, do not relitigate.** Spec §10
lists the action on a Worktree Map card and §6.1 lists `openInTerminal` on
`window.worktrees`; neither is built. There is no terminal-session seam a
worktree path can be handed to yet (W1 deferred it, W3 ruling A6 recorded it,
W5 re-affirmed it 2026-08-26), and the omit-don't-stub convention forbids a
disabled placeholder. The bridge exact set therefore has no `openInTerminal`
member and the card menu has no such item; the durable enforcement is an
absence-assertion test in
`packages/app-shell/src/worktree-map/__tests__/worktree-map-surface.test.tsx`
("offers no 'Open in Terminal' action anywhere on a card"), which W6 deletes in
the same PR that adds the real action. This sits beside the A5 run-scoped
`git worktree lock` deferral above for the same reason: both are capabilities
the spec named that no seam yet supports, and both are recorded here rather
than living only in a review thread.
```

`docs/agents/workspace-context.md` — the Map tab's capability gate and the checkout-intent seam (it is a one-shot request, NOT a second checkout writer; `useThreadCheckout` remains the only writer of `mastra_threads.metadata.checkout*`).

`docs/agents/assistant-providers.md` — a paragraph in the native-tool section, in the `manageCanvas`/`queryDiagnostics` style, recording that `brainstrike.listWorktrees` is `read`-risk on purpose (plan-mode orientation) while `brainstrike.manageWorktree` is `execute`-risk with `requiresApproval: true`, that both are desktop-only because the ledger and git live on the client, that they share one `workspace` discovery namespace entry, and that spec §6.4's three tool names collapsed to two ids with the risk split as the reason.

`docs/agents/assistant-persistence.md` — extend the WORKTREE LIFECYCLE KINDS section:

```md
`worktree.created` carries a `metadata.via` discriminator with a CLOSED
vocabulary: `'app'` (the Mode chip's create sheet), `'tool'` (the
`brainstrike.manageWorktree` agent tool), `'adopt'` (an existing worktree
recorded into the ledger), and `'shell'` (the agent's own `executeCommand`
ran `git worktree add` and the correlator reconciled). No new run-event kind
was added for shell correlation: a second kind would need its own pairing-
contract row and a second label vocabulary for the same fact.

Correlation reads the `executeCommand` TOOL RESULT, never the git-metadata
watcher. `GitInventoryInvalidation` carries `{ gitCommonDir, repositoryRoot }`
with no worktree path, no create-vs-remove discrimination, and a 300–2000 ms
coalescing window — attributing that to a run would be a temporal guess. The
correlator is fire-and-forget: it runs after the result exists and can never
delay or fail the tool call.

A `git worktree remove` run in a shell is reported as a VANISHED ledger row,
never archived: an archive carries a restorable snapshot and a shell removal
produced none. The ghost row's "missing on disk — restore it or archive it"
is the honest surface.
```

`packages/agent/AGENTS.md` — a `### brainstrike.listWorktrees / brainstrike.manageWorktree tools` section (purpose per action, the `create`/`archive` envelope, the refusal semantics, "desktop-only, excluded from `WebNativeToolId`"), as that file's numbered rule 6 requires.

- [ ] **Step 4: Full gate**

```bash
pnpm run build
pnpm run type-check
pnpm run lint:eslint
pnpm --filter @brainstrike/assistant-contract vitest run
pnpm --filter @brainstrike/agent vitest run
pnpm --filter @brainstrike/app-shell vitest run
pnpm --filter @brainstrike/file-explorer-ui vitest run
pnpm --filter @brainstrike/desktop vitest run
pnpm --filter @brainstrike/assistant-ui vitest run
pnpm run react-doctor
```

`@brainstrike/assistant-ui`'s lane is the FULL `pnpm vitest run` across every project in that package, not a `-t` subset — the pairing-contract suite lives there, and although this plan adds no kind, the `via` metadata change must not disturb it.

- [ ] **Step 5: Commit and push the stack**

```bash
pnpm dlx ultracite fix docs scripts
git add -A
git commit -m "docs(BST-1392): W5 contracts, provenance vocabulary and the CDT probe

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack push
```

Then verify each PR's base: PR 1 targets `integration/workspace-checkout-awareness`, and each subsequent PR targets the branch below it. Land bottom-up; if a base is squash-merged, rebase the child with `--onto` before merging it.

---

## Merge order

1. `seandearnaley/bst-1392-w5-map-contracts` → `integration/workspace-checkout-awareness`
2. `seandearnaley/bst-1392-w5-worktree-map`
3. `seandearnaley/bst-1392-w5-agent-tools`
4. `seandearnaley/bst-1392-w5-shell-correlation`
5. `seandearnaley/bst-1392-w5-verification`

---

## Explicitly out of scope (recorded, not built)

| Deferred | Owner |
| --- | --- |
| "Open in Terminal" on Map cards and in the Mode chip menu | W6 (no terminal-session seam yet; W3 ruling A6, re-affirmed 2026-08-26). Guarded by the Task 6 absence-assertion tripwire; delete that test in the W6 PR that adds the action. |
| Drag-drop folders, File ▸ Open Recent, `brainstrike <path>` | W6 [D7, D10] |
| Per-repository consent before running a repository setup script | BST-1455 |
| Run-scoped `git worktree lock` / `unlock` | W3 ruling A5 follow-up |
| Indexing ON by default for worktree roots | Blocked on the BST-393 hash-reuse measurement [D8] |
| `glab` / GitLab PR status | Follow-up; W4's stated "not supported yet" diagnostic stands |
| Auto-fix / auto-merge from the Map | Forbidden in v1 [D5] |
| A `worktree.archived` event for a shell `git worktree remove` | Deliberately never — there is no snapshot to restore from |

---

## Follow-ups this plan surfaces (file, do not build here)

| Follow-up | Why it is not W5 |
| --- | --- |
| **Unify the two worktree-indexing controls.** BST-1453's `WorktreeIndexingControl` (`packages/file-explorer-ui/src/components/worktree-indexing-control.tsx`) is keyed by ADAPTER root id and reads `worktreeRootIndexingByAdapterRootId`, while the Map's badge is keyed by the DURABLE `roots.id` and reads `worktreeRootIndexingOptInById`. Both write through the same `setWorktreeRootIndexingEnabled(dbRootId, …)` setter, so they cannot disagree about the persisted truth — but two components render the same fact from two different index maps. | Coordinator ruling (2026-08-26): the durable-keyed reuse is the RIGHT call for W5 (the Map has no adapter root id for an unmounted worktree, and inventing one would be a silent fallback). Unifying the two controls is BST-1453-family polish, not W5 scope. File it against that family. |

---

## Self-Review

**1. Spec coverage.** Every W5 line of the design has a task:

| Spec | Task |
| --- | --- |
| §5.3 provenance + `externalTool` label surfaced | Task 4 (`describeWorktreeProvenance`), Task 6 (the badge) |
| §5.4 PR cache read by a second surface | Task 4 (the `(repoCommonDir, branch)` join), Task 1 (`repoCommonDir`) |
| §6.1 `window.worktrees` grows honestly | Tasks 2, 3 (9 → 11 exact-set methods) |
| §6.2 the picker-less grant stays narrow | Task 2 (`adopt` refuses an unreachable path so `isManagedWorktreePath` is never widened) |
| §6.4 `createWorktree` / `listWorktrees` / `archiveWorktree` | Tasks 8–10. **Two ids, not three** — a coordinator-accepted deliberate deviation (A6): §6.4's protective intent (mutations gate through the permission engine) is fully preserved by `manageWorktree`; `listWorktrees` stays read-risk so plan-mode orientation still works. |
| §6.4 `created_by='agent'`, exact `run_id` provenance | Task 10 (capability closes over `runId`; the model cannot supply it) |
| §6.4 shell-output correlation → timeline event + ledger row | Tasks 11, 12 |
| §6.4 "via shell", labelled best-effort | Task 12 (label text + `metadata.via`), Task 14 (docs) |
| §10 repositories → lanes, primary first | Tasks 1, 4 |
| §10 card: name, branch, detached, dirty/unpushed, provenance, owning thread, PR pill, last activity | Tasks 3, 4, 6 |
| §10 actions: Open thread, New thread here, Reveal, Hand off, Archive, Add as root | Task 6. "Open in Terminal" is the ONE §10 action deliberately not built: deferred to **W6** by W3's A6 ruling and re-affirmed by the coordinator (2026-08-26), with an absence-assertion tripwire in Task 6 Step 4 so the omission is a contract rather than an oversight. |
| §10 live via `changes:invalidated` + `forge:prUpdated` | Task 5 (`anyInvalidationNonce`; `useForgePrCache` is a live query, so `forge:prUpdated` reaches the Map through the table it already writes) |
| §10 empty state, §10 D11 workspace app tab | Tasks 6, 7 |
| §11 timeline events | Task 12 (reusing `worktree.created` — A4) |
| §12 web omits everything | Tasks 7, 8 (no tab registration; both tool ids excluded from `WEB_NATIVE_TOOL_IDS`) |
| §13 no silent fallbacks | Tasks 1 (primary reason), 2 (adopt refusals), 5 (list/status failures), 6 (rendered reasons), 10 (absent capability throws) |
| §14 unit + integration + E2E + CDT | Tasks 1–6, 9–13, 14 |
| §16 D5 (no auto-fix), D8 (indexing off, badge), D11 (Map is a workspace app) | Task 6, Task 7, Scope boundaries |

**2. Placeholder scan.** No `TBD`, no "similar to Task N", no "add error handling". Two forward references are explicit and self-contained: Task 2 Step 7 adds `checkoutStatus` to the exact-set pin that Task 3 implements (stated in the step, so the pin is edited once rather than twice), and Task 12 Step 3 extracts `adoptDeps()` from the literal Tasks 2 and 3 build inline (both call sites named). The one deliberately unresolved value is the prompt-budget delta in Task 10 Step 7, which is `<measured>` because it MUST be read out of the test's own failure message — writing a guessed number there is exactly the failure that ledger exists to prevent.

**3. Type consistency.** Names used identically across tasks: `WorktreeListEntry` (+`createdAt`, `primary`, `repoCommonDir`), `WorktreeAdoptParams{createdBy,path,runId?,threadId?}`, `WorktreeCheckoutStatus{ahead,behind,clean,path,upstream}`, `WorktreeShellReconcileResult{adopted,vanishedLedgerIds}`, `WorktreeAdoptDeps`, `WorktreeMapCardModel`, `WorktreeMapRepositoryModel`, `WorktreeMapThread`, `WorktreeCheckoutStatusState` (3 variants: `error`, `loading`, `ready`), `WorktreeCheckoutIntent{branch,path,threadId,worktreeId}`, `WorktreeToolCapability{archive,create,list}`, `ShellCorrelationCapability{onCommandCompleted}`, `ShellGitCorrelationSignals{createdPullRequest,touchedWorktrees}`, `ListWorktreesInput`, `ManageWorktreeInput`, `ForgeRendererRefreshReason` (3 members) vs `ForgeRefreshReason` (4). `WORKTREES_BRIDGE_REQUIRED_METHODS` is 11 entries from Task 2 Step 7 onward and never varies again.

**4. Line-cap audit.** `worktree-service.ts` (1011), `assistant-tools.ts` (1004) and `use-workspace-bar.ts` (1031) all start at or over the ceiling. This plan adds no behavior to any of them: adoption/status/reconcile live in `worktree-adopt.ts`, the tool registrations in `worktree-tools.ts`, and the checkout-intent consumer in the 88-line `use-workspace-bar-mode.ts`. Every task that touches one runs `pnpm dlx ultracite check` on it explicitly, with the split — never a `biome.json` override — named as the remedy.

**5. Falsifiability audit.** The wiring tests that could pass on a swapped implementation are guarded: Task 6's Map-card adoption test asserts `archive`/`addRootDirectoryByPath` were NOT called when `Adopt` runs (**corrected at Task 2/3 execution** — Task 2's own picker-level adoption test made this same assertion, but the picker adoption branch it pinned turned out unreachable and was removed; the falsifier moved to Task 6, the surface that actually calls `worktrees.adopt` now); Task 5's load test asserts `adopt`/`archive` were not called; Task 10's executor tests assert the two sibling capability methods were not called; Task 12's correlator tests assert each signal drives ONE of the two effects and not the other. Task 13 case 5 asserts `metadata->>'via' = 'shell'` specifically, which is the assertion a watcher-based implementation would fail. Task 6's "Open in Terminal" tripwire asserts BOTH the text and the `menuitem` role are absent, because a disabled stub would satisfy a naive enabled-only query while being exactly what the ruling forbids.

**6. Coordinator rulings folded in (2026-08-26).** Four, each landed in the section that governs it rather than in a preamble a reviewer can skip: **(1)** BST-1392 confirmed against Linear — the Linear line now carries the verified title and Backlog state and drops the "inferred" hedge. **(2)** The A6 two-tool split is recorded IN the A6 row as a deliberate, accepted spec deviation with the "mutations gate, reads don't" rationale and a do-not-relitigate marker, and echoed in the §6.4 spec-coverage row. **(3)** "Open in Terminal" stays absent, with W6 named as owner in three places (Scope boundaries, Task 6's new deliberate-omissions table, the out-of-scope table) and enforced by a Task 6 tripwire that states its own deletion condition. **(4)** Durable-keyed indexing reuse is accepted; unifying it with BST-1453's adapter-keyed control moved to a new **Follow-ups this plan surfaces** section, not into any task.

**7. Independent-review revision pass (2026-08-26).** Nineteen findings dispositioned; the ones that changed executable content:

| Finding | Change |
| --- | --- |
| F1 — Layer-2 "phantom" symbols | Dissolved: the reviewer's checkout predated `949f11331`. The header now pins the branch point with a verifiable `git merge-base --is-ancestor` command, and Layer 2 gains **Step 0**, which checks whether #2655 wired its new persisted opt-in map into factory reset. Two of the three facts are confirmed present; the third (live-store reset on the no-reload web path) is a REAL gap the step fixes in-band, with the platform-contracts doc updated. |
| F2 — `updatedAt` typed as string | `AssistantMemoryThread.updatedAt` is a `Date` (`assistant-memory-repository.ts:62`) that `serializeThread` re-wraps on every load and `mergeThread` sorts on with `.getTime()`. `WorktreeMapThread.updatedAt` is now `Date \| null`, the `as never` fixtures are replaced by a real typed `thread()` factory, and a `toBeInstanceOf(Date)` assertion pins it — the assertion a cast fixture could never make. |
| F18 — raw ISO in the UI | `formatWorktreeActivity(at, now)` renders "just now" / "12 minutes ago" / "3 days ago" via `Intl.RelativeTimeFormat`, falling back to `Intl.DateTimeFormat` past a week and to a stated "at an unreadable time" for `NaN` — never "Invalid Date". `now`/`formatActivity` are injectable so the lane is deterministic without fake timers. |
| F3 — unsettled hook signature | `UseWorktreeMapInput { database, resourceId, runningThreadIds }` is declared in the Interfaces block and the RED test is written against it, with the thread-store and background-indexing-store mocks in place. The "update the calls later" note is gone; the file is `.ts`, not `.tsx`. |
| F4/F5 — prose-only components | `worktree-map-card.tsx` and `worktree-map-surface.tsx` are now complete code. The surface takes **no props** (the `ChangesSurface` shape, verified at `changes-surface.tsx:83`), which is also what settles "define the test's `props`" — there are none; the suite mocks the five context seams. The desktop wrapper's wiring is specified as a table naming each need, its resolver, and why it is already mounted. |
| F6 — missing parity fixtures | All three in `native-tool-catalog.test.ts` named with exact edits: the id array, `toHaveLength(34)` → `36`, and the third web-exclusion copy. `webIds` stays 24 (both ids are desktop-only). `native-tool-input-schema-catalog.spec.ts` and `tool-discovery-contract.test.ts` added to the Files lists. |
| F7 — false parity premise | Both tools now register inside the EXISTING `isLocalProvider ? {} : { … }` spread, which is what actually enforces Task 8's `LOCAL_DESKTOP_NATIVE_TOOL_IDS` exclusion. Two gate tests added. The "registers unconditionally" claim and its `unavailableToolIds` reasoning are deleted. |
| F8 — budget raise with no trade | The ledger paragraph now names three trim candidates and rejects each with a reason, records the structural trim actually taken (three tools → two), and instructs the executor to re-open the two-vs-three decision rather than widen the band. |
| F9–F17, F19 | `electron.d.ts` added to Tasks 2 and 3 with the reason it is not compiler-enforced; A1 rewritten as "latent today, reachable from Task 2" with the mechanism; the ordering test now registers all four optional apps plus an independence case; `EMPTY_THREADS` moved above the hook with the TDZ/identity rationale; `buildWorktreeMastraTools` gained a named return type; the sibling-collision note names the eight in-flight W3 files and warns that Task 2 Step 8 is a full replacement; the test path is `.ts`; the "both e2e helpers" phantom is replaced by the four real `WorktreeListEntry` sites; `resolvePlatformBridge` is the stated idiom in code, note and test mock; the run-event writer-binding hop is documented as already-bound-in-`main.ts` with an explicit "do not import the writer here". |
| Reviewer's cannot-verify | The W3 "Open in Terminal → W6" ruling now has a durable home: a full paragraph in the Task 14 `changeset-diff.md` pass, placed beside the A5 lock deferral, naming the tripwire test as its enforcement and W6 as the deleter. |

**8. Source hygiene.** The plan file contains no raw NUL bytes (`project_raw_nul_byte_source_guard`): Task 5's path-key sample originally used a `'\0'` join separator, which serialized as a literal NUL into this document and would have tripped the repo's NUL guard on commit. It now uses `JSON.stringify`/`JSON.parse`, which is also the better code — a POSIX path may contain any byte except NUL, so no single delimiter character is safe. Verified with `python3 -c "assert b'\x00' not in open(<plan>,'rb').read()"`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-26-w5-worktree-map-and-agent-tools.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks. Layers 2 and 3 run CONCURRENTLY in isolated worktrees (`isolation: 'worktree'`); everything else is sequential.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**

