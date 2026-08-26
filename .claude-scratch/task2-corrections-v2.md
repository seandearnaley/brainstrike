# Task 2 — round 2 corrections (read after task2-corrections.md)

A prior codex attempt correctly stopped at Step 8's test code: the brief's Step 8 test block references
`adoptMock`, `listMock`, `args`, `createMock`, `restoreMock`, `archiveMock` — none of which existed in
`packages/app-shell/src/__tests__/use-worktree-mode.test.ts` (confirmed via `rg`, all NO_MATCH). That test file
was ALREADY corrected once during Task 1 (the `listMock`/`args` aliases were removed in favor of the file's own
`listSpy`/`ARGS`), so the brief's Step 8 snippet is stale against those names too.

**This has now been fully resolved for you — the test-file side of Step 8 is DONE. Do not re-touch
`packages/app-shell/src/__tests__/use-worktree-mode.test.ts`'s mock setup or its two new adoption tests.**
Specifically, already done, verified by running the file (confirmed 28 pre-existing tests still pass, and the
2 new tests correctly fail RED against today's `onSelectExisting`, which still throws the old
"Unreachable worktree picker state" error for an unmanaged row):

1. The `vi.hoisted` block at the top of the file now also declares `adoptSpy` and `restoreSpy` (alphabetically
   placed among the existing `addRootByPathSpy`/`addRootDirectorySpy`/`archiveSpy`/etc.).
2. The `vi.mock('../worktrees/worktrees-bridge', ...)` factory now wires `adopt: adoptSpy` and
   `restore: restoreSpy` (replacing the old anonymous `restore: vi.fn()`).
3. Two new tests were added, verbatim in spirit from the brief's Step 8 but using the file's real names:
   `adoptSpy` (not `adoptMock`), `listSpy` (not `listMock`), `ARGS` (not `args`), `createSpy` (not `createMock`),
   `restoreSpy` (not `restoreMock`), `archiveSpy` (not `archiveMock`), `onSelectWorktree` directly (not
   `args.onSelectWorktree` — `onSelectWorktree` is already a top-level const in this file, wired into `ARGS`),
   `toastSpy` directly (not `toast` — this file never imports `toast`, only mocks it as `toastSpy`). Same
   assertions, same error strings, same shape as the brief otherwise.

**Your job now:** implement everything ELSE Task 2's brief (plus task2-corrections.md's first three corrections)
calls for, so those two new tests — and the rest of Step 9's affected lanes — go GREEN:
- Step 3: `WorktreeAdoptParams` in `packages/types/src/worktree.ts`.
- Step 4: `apps/desktop/src/assistant-server/worktree-adopt.ts` (new file), WITH corrections #1-#3 from
  `task2-corrections.md` (drop the `WorktreeCheckoutStatus` import, use `generateWorkspaceSnapshotId()` not the
  `uuidv7` npm package, add the primary-checkout guard + its one extra test case in
  `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`, which you create fresh — write ALL 6 of
  its test cases: the brief's original 5 plus the primary-checkout-refusal one from the corrections file).
- Steps 6-7: expose `adopt` on the service (`worktree-service.ts`), the run-event emitter
  (`worktree-run-events.ts`), and thread it across the IPC/bridge layer exactly as the brief specifies, PLUS the
  `checkoutStatus` plumbing below (this was investigated and verified against Task 3's own section of the full
  plan document at `docs/superpowers/plans/2026-08-26-w5-worktree-map-and-agent-tools.md` — line ~1272 has
  `WorktreeCheckoutStatus`'s exact shape, line ~1281 has `checkoutStatus`'s exact signature — this is not a
  guess, it is read directly from that already-committed document):

  a) `packages/types/src/worktree.ts`: add, alongside `WorktreeAdoptParams`, this type verbatim from Task 3's
     Interfaces section:
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
     (Now `worktree-adopt.ts`'s Step 4 import list, after dropping it per correction #1 above, can be revisited:
     it is still correct to drop it from `worktree-adopt.ts` specifically, since nothing in Task 2's
     `worktree-adopt.ts` body uses `WorktreeCheckoutStatus` — Task 3 adds the function that needs it, in the
     SAME file, later. This type only needs to exist in `@brainstrike/types` now for the bridge/electron.d.ts
     signatures below to type-check.)

  b) `apps/desktop/src/platform/desktop-ipc-channels.ts`: add BOTH `adopt: 'worktrees:adopt'` and
     `checkoutStatus: 'worktrees:checkoutStatus'` to the `worktrees` block (alphabetical), per the brief's own
     Step 7 snippet which already shows both.

  c) `packages/app-shell/src/worktrees/worktrees-bridge.ts`: add BOTH methods to the `WorktreesBridge` interface:
     ```ts
     adopt: (params: WorktreeAdoptParams) => Promise<GitResult<ManagedWorktreeRow>>;
     ```
     and
     ```ts
     checkoutStatus: (params: { readonly path: string }) => Promise<GitResult<WorktreeCheckoutStatus>>;
     ```
     (add `WorktreeAdoptParams` and `WorktreeCheckoutStatus` to this file's own `@brainstrike/types` import list),
     plus both entries in `WORKTREES_BRIDGE_REQUIRED_METHOD_SET` (brief already shows this).
     **This is load-bearing, not cosmetic**: `resolveWorktreesBridge()` in this same file checks the REAL
     `window.worktrees` object against every name in `WORKTREES_BRIDGE_REQUIRED_METHODS` at runtime — if
     `checkoutStatus` is in the required set but preload.ts does not actually expose a `checkoutStatus`
     function, `resolveWorktreesBridge()` logs an error and returns `null`, disabling the ENTIRE worktrees
     bridge (not just checkoutStatus). So step (e) below is mandatory, not optional.

  d) `apps/desktop/src/types/electron.d.ts`: add both `adopt` and `checkoutStatus` window declarations with the
     same signatures as (c), per the brief's own Files-list note for this file.

  e) `apps/desktop/src/preload.ts`: expose BOTH as real passthroughs in the `contextBridge.exposeInMainWorld('worktrees', {...})` object:
     ```ts
     adopt: (params: WorktreeAdoptParams) => ipcRenderer.invoke(WORKTREES_ADOPT_CHANNEL, params),
     ```
     and
     ```ts
     checkoutStatus: (params: { path: string }) =>
       ipcRenderer.invoke(WORKTREES_CHECKOUT_STATUS_CHANNEL, params),
     ```
     (add the two new `const WORKTREES_ADOPT_CHANNEL = 'worktrees:adopt' as const;` /
     `const WORKTREES_CHECKOUT_STATUS_CHANNEL = 'worktrees:checkoutStatus' as const;` alongside the existing
     `WORKTREES_*_CHANNEL` constants, matching this file's established pattern). `checkoutStatus`'s IPC channel
     will have NO main-process listener registered until Task 3 — that is fine and intentional (nothing calls
     `bridge.checkoutStatus()` yet); only its exposure needs to exist now, for the reason in (c).

  f) Do NOT add `checkoutStatus` to `apps/desktop/src/worktrees-ipc-handlers.ts` (`WorktreesIpcHandlers`
     interface or its validator/factory) or to `apps/desktop/src/ipc-worktrees.ts` (its
     `registry.registerAuthorizedInvoke(...)` calls) or to `WorktreeService` — Task 3 owns all three, since
     `WorktreeService` does not have a `checkoutStatus` method yet and there is nothing for a main-process
     handler to call. Only `adopt` gets the full handler/registration/service treatment in Task 2, exactly as
     the brief's given snippets show.

  g) `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`'s `'keeps preload bridge channel literals in
     parity with the desktop IPC channel catalog'` test has a hand-maintained `expectedConstants` object
     (alphabetically ordered `WORKTREES_*_CHANNEL` keys around line 353-361) that will now fail unless you add
     BOTH new lines, alphabetically placed:
     ```ts
     WORKTREES_ADOPT_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.adopt,
     WORKTREES_ARCHIVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.archive,
     WORKTREES_CHECKOUT_STATUS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.checkoutStatus,
     WORKTREES_CREATE_BRANCH_HERE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.createBranchHere,
     ```
     (only `WORKTREES_ADOPT_CHANNEL` and `WORKTREES_CHECKOUT_STATUS_CHANNEL` are new; the other two shown are
     existing anchors). This is a SEPARATE hand-maintained list from the one in preload.ts itself — both must
     agree, which is exactly what this test enforces.
- Step 8: apply ONLY the production-code change to `packages/app-shell/src/hooks/use-worktree-mode.ts`
  (`onSelectExisting` gains the real adoption call) exactly as the brief specifies. Do NOT touch
  `use-worktree-mode.test.ts` at all — it is already correct and already RED against the old code.
- Step 9: run the affected lanes (corrected commands below, since neither package has a bare `vitest` script):
  ```bash
  pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
  pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/use-worktree-mode.test.ts src/worktrees/__tests__
  ```
  Expect: worktree-adopt.test.ts 6/6 passed (5 brief + 1 primary-refusal), preload-runtime-contract.test.ts all
  passed, use-worktree-mode.test.ts 30/30 passed (28 pre-existing + 2 new adoption tests), worktrees-bridge.test.ts
  suite passed.

Do NOT commit, do NOT push — same as before. Report files touched, pass/fail counts for all four suites above,
and any deviation with justification. If you hit ANY other brief-references-something-that-doesn't-exist
situation beyond what's already covered here, STOP and report it precisely (grep/ls output) rather than
inventing a shape for it.
