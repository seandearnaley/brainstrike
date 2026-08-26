# Task 3 corrections — what's already done, what's still needed, known gotchas

## Already done in Task 2 (verified byte-identical to this brief's spec — do NOT redo, do NOT re-add)

- `packages/types/src/worktree.ts` already exports `WorktreeCheckoutStatus` with the EXACT shape this
  brief's Interfaces section shows (`ahead`, `behind`, `clean`, `path`, `upstream`). Confirmed via direct
  file read — do not touch this file for Task 3.
- `apps/desktop/src/platform/desktop-ipc-channels.ts` already has `checkoutStatus: 'worktrees:checkoutStatus'`
  in the `worktrees` block.
- `packages/app-shell/src/worktrees/worktrees-bridge.ts` already has `checkoutStatus` on the
  `WorktreesBridge` interface (`(params: { readonly path: string }) => Promise<GitResult<WorktreeCheckoutStatus>>`)
  and in `WORKTREES_BRIDGE_REQUIRED_METHOD_SET`.
- `apps/desktop/src/types/electron.d.ts` already declares `checkoutStatus` on the `window.worktrees` block.
- `apps/desktop/src/preload.ts` already exposes a real `checkoutStatus` passthrough
  (`WORKTREES_CHECKOUT_STATUS_CHANNEL` constant + `contextBridge.exposeInMainWorld('worktrees', { checkoutStatus: ... })`).
- `apps/desktop/src/__tests__/preload-runtime-contract.test.ts` already has `WORKTREES_CHECKOUT_STATUS_CHANNEL`
  in its hand-maintained `expectedConstants` parity list.

Do not touch any of the six files above for Task 3 — verify they exist (a quick grep), then move on. If you
find any of them actually missing or different from what's described, STOP and report exactly what you found
instead of guessing — this is the same "escalate rather than improvise" rule as every prior task in this chain.

## Still needed (this brief's real remaining work)

1. `apps/desktop/src/assistant-server/worktree-adopt.ts`: add `readCheckoutStatus` per Step 3. Two imports
   need RESTORING that Task 2 deliberately dropped as unused-at-the-time forward references:
   - `parsePorcelainV2Z` from `./git-service` (add back to the existing `import { describeFailure, type
     GitCommandRunner, invokeGitHookFree } from './git-service';` line, alphabetically).
   - `WorktreeCheckoutStatus` from `@brainstrike/types` (add to the existing `import type { ... } from
     '@brainstrike/types';` block, alphabetically — it already imports `GitInventory, GitResult,
     ManagedWorktreeRow, WorktreeAdoptParams, WorktreeDescriptor, WorktreeListEntry, WorktreeSettings`).
   Use `locate(inventory, params.path)` exactly as this brief's Step 3 code shows — that helper already
   exists in this file (added in Task 2) and already returns `{ descriptor, repoCommonDir, repositoryRoot }`;
   `readCheckoutStatus` only needs the boolean "was it found" per the brief's own code (`if (!locate(...))`),
   so no change to `locate` itself is needed.

2. `apps/desktop/src/assistant-server/worktree-service.ts`: add the `checkoutStatus` method to the service's
   returned object per Step 3's second snippet — OUTSIDE the `serialize(...)` mutex, exactly as the brief
   says (it's a read, must not queue behind a create). Alphabetical placement in the returned object (the
   file's existing methods are alphabetically ordered: `adopt`, `archive`, `create`, ... — `checkoutStatus`
   goes right after `archive`, before `create`).

3. `apps/desktop/src/worktrees-ipc-handlers.ts`: add `validateCheckoutStatus` (Step 3's third snippet) and a
   `checkoutStatus` slot to the `WorktreesIpcHandlers` interface, wired into the handler factory the same way
   `adopt` was wired in Task 2 (there is exactly one existing precedent to follow for both the interface slot
   and the factory wiring — read how `adopt` was added there before writing this).

4. `apps/desktop/src/ipc-worktrees.ts`: add ONE new `registry.registerAuthorizedInvoke('worktrees',
   DESKTOP_IPC_CHANNELS.worktrees.checkoutStatus, { roles: ['visible-ui'] }, (_event, payload: unknown) =>
   handlers.checkoutStatus(payload))` call, matching the existing `adopt`/`archive`/etc. calls' exact shape.
   This file now registers 11 channels total (was 10 after Task 2's `adopt` addition).

5. Any test file with a hand-maintained exact channel COUNT or a hand-built `WorktreesIpcHandlers`/mock-bridge
   object literal will need the same treatment Task 2 needed. Known from Task 2's own experience (search for
   these patterns yourself too — do not assume this list is exhaustive):
   - `apps/desktop/src/__tests__/ipc-worktrees.test.ts` — `ALL_WORKTREE_CHANNELS` array, `stubHandlers()`
     return object, `clearHandlerMocks()`, `toHaveLength(N)` assertions (currently 10, will become 11), and
     every "routes to the correct handler, none of the others" test block needs one more
     `expect(handlers.checkoutStatus).not.toHaveBeenCalled()` line added to each of the OTHER handlers'
     blocks, plus a new block for `checkoutStatus` itself asserting the others are NOT called.
   - `packages/app-shell/src/__tests__/use-roots-reconciliation.test.tsx` — a `satisfies WorktreesBridge`
     hand-built mock (already has `adopt`/`checkoutStatus` stubs from Task 2 — verify, don't just assume).
   - `packages/app-shell/src/__tests__/use-workspace-bar.test.tsx` and
     `use-workspace-bar-write-tail.test.tsx` — `installWorktreesBridge()` (already has both from Task 2 —
     verify).
   - `packages/app-shell/src/worktrees/__tests__/worktrees-bridge.test.ts` — the hardcoded
     `'declares exactly the eleven ops...'` list (already includes `checkoutStatus` from Task 2 — this one
     does NOT need a count bump since the bridge interface itself doesn't gain a new REQUIRED method in
     Task 3, only a real handler; verify by running the file, don't guess).
   Run the FULL desktop and app-shell unit lanes yourself after implementing (not just the four suites the
   brief names) — Task 2's own experience was that the monorepo type-check and full lanes caught several
   ripple effects the brief's own "Step 4: Run it to verify it passes" command never would have.

6. `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`: append the brief's Step 1
   `describe('readCheckoutStatus', ...)` block VERBATIM — it already imports everything it needs from this
   file's existing `SETTINGS`/`inventory`/`makeDeps`... WAIT: this file uses `makeDeps`, not the brief's
   `deps` object literal shown inline in Step 1's code. Re-read this file's OWN actual current structure
   (`makeDeps`, `inventory`, `SETTINGS`) before writing the two `readCheckoutStatus` tests — adapt the
   brief's Step 1 snippet's inline `deps` object construction to use the EXISTING `makeDeps`/`inventory`
   helpers already in this file (same spirit as the brief's own tests for `adoptWorktree`), rather than
   duplicating a second ad-hoc `deps` builder. This file's `inventory()` helper ALSO needs its `bare: false`
   field (added during Task 2's own gate-fixing after finding the brief's original inventory() helper was
   missing it) — that field is ALREADY THERE from Task 2, verify it before assuming you need to add it again.

7. Two known bugs in THIS brief's own given fixture code (found and fixed during Task 2's analogous work —
   check for the SAME class of bug here before trusting the brief's snippets verbatim):
   - Step 1's inline mock `run = vi.fn(async () => ({ exitCode: 0, signal: null, stderr: '', stdout: ... }))`
     has the same `signal: null` / missing `timedOut: boolean` bug Task 2's brief had. `GitCommandRun` has NO
     `signal` field; it requires `timedOut: boolean`. Fix to `{ exitCode: 0, stderr: '', stdout: ..., timedOut:
     false }` — or better, if this test file's existing `makeDeps`/`run` helper (from Task 2, already fixed)
     can be reused/adapted instead of building yet another ad-hoc mock, prefer that.
   - `invokeGitHookFree` (used inside `readCheckoutStatus`, same as `adoptWorktree`) ALWAYS makes a
     preliminary hook-config probe call before the real `git status` invocation — so
     `expect(run).toHaveBeenCalledTimes(1)` in the brief's Step 1 test is WRONG for the same reason Task 2's
     `run).toHaveBeenCalledTimes(1)` was wrong; it should be `toHaveBeenCalledTimes(2)`. Do NOT weaken
     `readCheckoutStatus` to bypass `invokeGitHookFree` to make the count 1 — that would remove a real
     security property (never running a repository-configured hook against an externally-discovered
     worktree). Fix the assertion, not the implementation, exactly as Task 2's `adoptWorktree` test was
     fixed. Also check `run.mock.calls[0]?.[0]` in the brief — since there are now TWO calls, verify which
     call index (0 or 1) actually receives `{ cwd: '/repo/wt', ... }` (the SECOND call, index 1, is the real
     `git status` invocation with `args: ['status', '--porcelain=v2', '--branch', '-z']` — the FIRST, index 0,
     is the hook-config probe with different args) and correct the test's assertion index accordingly, do not
     leave it checking the wrong call.

8. Create `apps/desktop/src/__tests__/assistant-server/worktree-adopt.integration.test.ts` per Step 5,
   verbatim — this is a genuinely new file with no known Task 2 gotchas (it drives real git directly via
   `execFile`, not through this repo's `worktree-service.shared.ts` fixtures, so it should not hit the same
   `bare`/`timedOut` issues). Still run it for real and read its actual output before declaring it green —
   do not assume it passes just because it matches the brief.

## Corrected run commands (same tooling gap every prior task hit)

```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
pnpm --filter @brainstrike/desktop exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-adopt.integration.test.ts
pnpm --filter @brainstrike/app-shell exec vitest run --exclude "**/*.integration.test.*"
```

Expect worktree-adopt.test.ts to have MORE than 8 passing (6 from Task 2 + 2 new `readCheckoutStatus` cases),
preload-runtime-contract.test.ts all passing, the integration test 1 passing, and the full app-shell lane
green.

Do NOT commit, do NOT push, do NOT run `gh stack submit` (Step 6 of the brief says to, but the calling
process handles commit/gates — the coordinator will handle any stack submission separately, much later).
Stop once everything is green and report exactly what you touched, what you skipped as already-done (per the
"already done" list above — confirm each with a one-line note), pass/fail counts for every suite named above,
and any deviation with justification. If you hit ANY brief-references-something-that-does-not-exist situation
not already covered by this document, STOP, do not invent scaffolding or guess a shape, and report exactly
what's missing with the grep/rg/ls output you used to verify it.
