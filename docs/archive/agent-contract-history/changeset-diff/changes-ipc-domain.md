# The changes IPC domain — evidence

Supports `docs/agents/changeset-diff.md` § "THE `changes` IPC DOMAIN".
Read before adding an invoke, moving a mode between the `changes` and `git` domains, or changing bridge capability resolution.

The lines below are the pre-distillation contract text, extracted verbatim.

`apps/desktop/src/ipc-domains/changes.contract.ts` is the source of truth for
seven visible-UI-only invokes (`resolveView`, `fileDiff`, `inventory`, and the
four rewind operations) plus the `changes:invalidated` push. Main registration,
the preload bridge, and desktop `Window` typing derive from that contract;
`BridgeMatches` pins the result to app-shell's `ChangesBridge`. Invokes retain
the raw `GitResult` envelope. Contract parsers reject structurally malformed
direct IPC before handler entry, while handlers in
`apps/desktop/src/changes-ipc-handlers.ts` retain semantic validation
(`validateChangeset`/`validatePath`/`validateGitScope`) before anything
typed reaches `ChangesetDiffService` — unknown `Changeset.kind`s and
unsupported/extra keys are rejected explicitly, mirroring
`git-structured-diff.ts`'s own params validation.

Preload exposes `window.changes` through `exposeBridge('changes',
changesContract)`, gated by `shouldExposeBridge('changes')`. Renderer capability resolution:
`packages/app-shell/src/changes/changes-bridge.ts`'s `resolveChangesBridge()`
— returns `null` on web (no bridge), and `null` **plus a logged error** for
a present-but-malformed bridge (missing any of `REQUIRED_METHODS`). No
`isElectron()` check anywhere. Guarded by `changes-bridge.test.ts`'s
`it.each` over every `ChangesBridge` key.

The `commit`/`range` `StructuredFileDiffParams` modes are exposed on the
**separate** `git` IPC domain (`window.git.structuredFileDiff`), not
`window.changes` — the History tab's commit-diff pane calls straight
through `window.git` (the same bridge it already uses for
`history`/`commitFiles`) rather than adding a second bridge dependency
(see RENDERER SURFACES below). The legacy `commitDiff` op was REMOVED
end-to-end in BST-1161 (bridge, preload, IPC channel, handler,
`git-history.ts` op) once its last renderer call site was gone —
`structuredFileDiff`'s `commit` mode is the sole historical-diff path.
