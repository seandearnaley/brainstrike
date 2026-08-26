# Corrections and additions to task-2-brief.md (verified against this worktree's actual HEAD)

These are pre-verified facts about THIS repo checkout — not guesses. Apply them as you implement; do not
re-derive or second-guess them.

## 1. Drop the unused `WorktreeCheckoutStatus` import in Step 4's `worktree-adopt.ts`

The brief's Step 4 code block imports `WorktreeCheckoutStatus` from `@brainstrike/types`:
```ts
import type {
  GitInventory,
  GitResult,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeCheckoutStatus,
  WorktreeDescriptor,
  WorktreeSettings,
} from '@brainstrike/types';
```
`WorktreeCheckoutStatus` does NOT exist anywhere in `packages/types/src/worktree.ts` (or any other types
package file) at this HEAD, and Task 2's own Step 3 does not add it either (Step 3 only adds
`WorktreeAdoptParams`). It is also never referenced anywhere else in Task 2's own code (checked: no usage in
any Step 4 function body). It is forward-looking scaffolding for Task 3 (`checkoutStatus`), which will add
that type when it actually needs it. **Drop `WorktreeCheckoutStatus` from this import list** — import only
`GitInventory, GitResult, ManagedWorktreeRow, WorktreeAdoptParams, WorktreeDescriptor, WorktreeSettings`. Do
NOT invent a definition for `WorktreeCheckoutStatus` yourself — that is out of scope for Task 2 and belongs to
whichever brief actually specifies its shape.

## 2. Use `generateWorkspaceSnapshotId()`, not the `uuidv7` npm package

The brief's Step 4 code calls `uuidv7()` imported from the `'uuidv7'` npm package. That package is NOT a
dependency of `apps/desktop` (confirmed: `grep uuidv7 apps/desktop/package.json` — no match). The brief
itself anticipates this ("If uuidv7 is not already a dependency of apps/desktop, use the SAME import
worktree-ledger.ts/worktree-service.ts use for its ids — copy that import line verbatim rather than adding a
package"). The actual id-minting function this codebase uses for `ManagedWorktreeRow.id` (see
`apps/desktop/src/assistant-server/worktree-service.ts` line ~216, `insertCreatedWorktree`) is
`generateWorkspaceSnapshotId()` imported from `./snapshot-repository` — despite its name, it is a general
app-side uuidv7 minter (see its own doc comment: "Ids are app-side uuidv7 (time-sortable...)"). In
`worktree-adopt.ts`, replace:
```ts
import { uuidv7 } from 'uuidv7';
```
with:
```ts
import { generateWorkspaceSnapshotId } from './snapshot-repository';
```
and replace the one call site `id: uuidv7(),` with `id: generateWorkspaceSnapshotId(),`.

## 3. Add a primary-checkout guard to `adoptWorktree` itself (folds in a reviewer design caution from Task 1)

Task 1's `PRIMARY_CHECKOUT_GATE` refuses the repository's own primary checkout as a `list()` entry, but
nothing in Task 2's given `adoptWorktree` implementation checks whether the target path IS the repository's
primary checkout before inserting a ledger row for it — `locate()` only returns `{ descriptor, repoCommonDir }`,
dropping `repository.identity.repositoryRoot` on the floor. Since this same `adoptWorktree` function is also
what the agent-facing `worktrees:adopt` tool will eventually call directly (bypassing the picker's UI-level
disabling entirely), this is a real gap, not just defense-in-depth: an agent (or a future caller) could adopt
the user's own primary checkout as if it were an ordinary unmanaged worktree.

Make these two additions to the Step 4 code:

a) Widen `LocatedWorktree`/`locate()` to also carry `repositoryRoot`:
```ts
interface LocatedWorktree {
  readonly descriptor: WorktreeDescriptor;
  readonly repoCommonDir: string;
  readonly repositoryRoot: string;
}

function locate(inventory: GitInventory, target: string): LocatedWorktree | null {
  for (const repository of inventory.repositories) {
    for (const descriptor of repository.worktrees) {
      if (descriptor.path === target) {
        return {
          descriptor,
          repoCommonDir: repository.identity.gitCommonDir,
          repositoryRoot: repository.identity.repositoryRoot,
        };
      }
    }
  }
  return null;
}
```

b) In `adoptWorktree`, immediately after destructuring `located` (BEFORE the `prunableReason` check — this is
an absolute, no-remedy refusal, same priority as `PRIMARY_CHECKOUT_GATE` taking precedence over
`resolveUsability` in `worktree-service.ts`), add:
```ts
  const { descriptor, repoCommonDir, repositoryRoot } = located;
  if (descriptor.path === repositoryRoot) {
    return {
      error: `The worktree at "${params.path}" is the repository's primary checkout — use Hand off to Local instead.`,
      ok: false,
    };
  }
```

c) Add ONE new test case to `worktree-adopt.test.ts`, alongside the brief's other five, using the file's own
`inventory()` helper (which already hardcodes `identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' }`,
so a descriptor whose `path` is `'/repo'` IS the primary — no new fixture needed):
```ts
  it("refuses to adopt the repository's own primary checkout", async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: inventory([{ path: '/repo' }]),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo' });

    expect(result).toEqual({
      error:
        'The worktree at "/repo" is the repository\'s primary checkout — use Hand off to Local instead.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });
```
This becomes the file's 6th test case (brief's Step 5 "Expected: 5 passed" becomes 6 passed after this addition
— note that in your report).

## 4. Corrected test-run commands (same tooling gap as Task 1)

Neither `apps/desktop` nor `packages/app-shell` defines a `vitest` script directly (only `test`/`test:integration`).
The brief's literal `pnpm --filter @brainstrike/desktop vitest run …` / `pnpm --filter @brainstrike/app-shell vitest run …`
commands will fail with "Missing script". Use instead:
```bash
pnpm --filter @brainstrike/desktop exec vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
pnpm --filter @brainstrike/app-shell exec vitest run src/__tests__/use-worktree-mode.test.ts src/worktrees/__tests__
```
