# Open in Terminal — the W6 seam — evidence

Supports `docs/agents/changeset-diff.md` § "WORKTREE MAP + ADOPTION".
Read before changing the terminal target pin, `terminal:create`'s `cwd`, or the rootId/cwd pairing.

The lines below are the pre-distillation contract text, extracted verbatim.

**"Open in Terminal" — SHIPPED in W6 (BST-1457); the deferral and its tripwire
are gone.** Spec §10 lists the action on a Worktree Map card, §4.1 on the Folder
chip's root rows and §4.3 on the Mode chip's worktree menu; all three exist. The
seam is the app's OWN Terminal workspace app, not the OS terminal emulator and
not `window.worktrees`: `worktrees` gains no `openInTerminal` member (spec §6.1
placed it there, but the action mutates nothing and needs no main-side worktree
state — recorded as W6 ruling T1), and an external emulator was rejected because
it would hand a shell to a path the app never containment-checked, with no
honest cross-platform story (T2).

Two pieces make it work. `terminal:create` accepts an optional `cwd` that is
realpath'd and SEPARATOR-ANCHORED containment-checked inside the already-
validated root (`resolveContainedCwd` in `apps/desktop/src/workspace-root-cwd.ts`);
omitted, behavior is byte-for-byte what it was. The parameter is not a
convenience: `WorktreeListEntry.rootId` is the first root CONTAINING a checkout,
not its own mount (`rootIdIsExactMount` is that flag), so a worktree nested at
`.claude/worktrees/<name>` under an open repo resolves to the PARENT's root id —
pinning the shell to `rootId` alone would silently open it in the wrong
repository. Every surface therefore passes BOTH `{ cwd: <checkout path>,
rootId: <containing root> }`. On the renderer side a session-lived
`terminal-target-store` (`packages/app-shell/src/stores/`) holds a STANDING pin;
`openTerminalAt` sets it, switches the shell route to `explorer` and opens the
Terminal app tab (it owns both halves, unlike `changes-navigation-store`, because
all three callers need the identical pair). `TerminalPanel` derives
`target ?? focused root` during render — never an effect mirror — and renders an
explicit "Follow focused folder" release so a pin is reversible rather than a
trap. `useTerminalSession`'s outcome-freshness gate keys on the (rootId, cwd)
PAIR: the lifecycle effect re-runs on a pin change without bumping `sessionId`,
so a rootId-only gate would leak the previous checkout's `exited` overlay onto
the freshly-starting one.

On a Map card the item renders exactly when `entry.rootId !== null`, and
`Add as root` renders exactly when it is `null` — complementary, so the menu
always names the next step and never shows a disabled action. Web has no
`window.terminal`, so `isTerminalBridgeAvailable()` is false and no surface
supplies the handler: the item does not exist there in any form. The W5
absence-assertion tripwire in `worktree-map-surface.test.tsx` was DELETED in
the same PR that added the action, as its own comment instructed; the sibling
assertion in `mode-chip.test.tsx` survives, repurposed from a deferral
tripwire into an ordinary handler-presence contract.

The A5 run-scoped `git worktree lock` deferral above still stands on its own —
it remains a capability the spec named that no seam yet supports.
