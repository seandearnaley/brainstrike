# The worktrees IPC domain — evidence

Supports `docs/agents/changeset-diff.md` § "THE `worktrees` IPC DOMAIN".
Read before adding a method or moving validation between the contract parser and the handlers.

The lines below are the pre-distillation contract text, extracted verbatim.

`apps/desktop/src/ipc-domains/worktrees.contract.ts` defines the twelve-method
visible-UI-only domain. `registerDomain`, `exposeBridge`, and
`Bridge<typeof worktreesContract>` derive main registration, preload exposure,
and the desktop ambient type; `BridgeMatches` pins the result to app-shell's
`WorktreesBridge`. Structural parser failures reject malformed direct IPC
before handler entry, while absolute-path and service semantics stay in
`worktrees-ipc-handlers.ts` and retain raw `GitResult` failures. The
`packages/app-shell/src/worktrees/worktrees-bridge.ts` rejects a
present-but-incomplete bridge wholesale. All twelve methods — `adopt`,
`archive`, `checkoutStatus`, `create`, `createBranchHere`, `createContext`,
`getSettings`, `inspectArchive`, `list`, `listManagedPaths`, `restore`,
`setSettings` — are
implemented and the lifecycle mutations call real `WorktreeService` methods.
`adopt` and `checkoutStatus` (BST-1392, W5) are the two most recent additions:
`adopt` records an existing on-disk worktree the live inventory already
reports into the ledger (refusing an unvalidated, prunable, locked, primary,
unreachable, or already-managed/archived target — never a caller-supplied
path outside that inventory); `checkoutStatus` is a lazy, per-checkout
`git status` read (ahead/behind/clean/upstream) kept OUTSIDE the mutation
mutex, since it is a read and must not queue behind a create. Managed-directory
settings persist through `assistant-server/worktree-settings.ts`, with `null`
recomputed as the home-relative default on every read. The exact bridge set,
IPC narrowing, preload parity, and settings persistence are pinned by the
corresponding `worktrees-*` and preload-runtime contract tests.
