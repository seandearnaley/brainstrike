# Per-worktree setup hooks and consent — evidence

Supports `docs/agents/changeset-diff.md` § "SETUP HOOKS / PER-WORKTREE SETUP — granted roots only".
Read before changing setup execution, consent persistence, `.worktreeinclude` copying, or the spawn/settlement model.

The lines below are the pre-distillation contract text, extracted verbatim.

Repository code runs only while creating a worktree FROM a repository the user
explicitly opened as a workspace root. `createUnserialized` starts with
`resolveRepositoryContext(params.rootId)`, which resolves that durable
`roots.id` through `deps.resolveRootCwd(rootId)` before setup is reachable.
After creation it is the sole caller of `runSetupSafely` → `deps.runSetup` →
`runWorktreeSetup`. Repositories surfaced only through inventory/list discovery
have no path to setup execution. This is the Conductor / Claude Code convention:
`setupCommand` is tri-state: an argv array runs that explicit command, `null`
falls back to `.brainstrike/worktree-setup.sh` when present, and `'disabled'`
does not run or probe any setup command. Explicit argv and `'disabled'` bypass
repository-script consent because neither executes the repository fallback.

Before the first repository-script execution, `createContext` reports the
repository root, absolute script path, and repository identity (the Git common
directory). The create sheet blocks until the user allows or skips that script
and warns that it runs local shell code with `BRAINSTRIKE_WORKSPACE_*` variables
and that `.worktreeinclude` can copy gitignored files. Both decisions persist in
the renderer's `worktree-setup-consent.v1` store, keyed by Git common directory,
so later creates and app restarts do not prompt again. Factory reset clears the
store. Create IPC carries the renderer decision plus repository identity; main
pins that identity to its freshly resolved common directory before forwarding
the decision. Missing or mismatched consent fails closed to a visible `skipped`
setup outcome while worktree creation continues. A denial behaves the same way
and never executes the script.

`.worktreeinclude` copies gitignored source files into the new worktree, one
root-relative glob pattern per non-comment line. Absolute and `..`-escaping
patterns are rejected before filesystem access. Every resolved match is also
`realpath`-checked against the source root, and each existing/write-side target
parent is `realpath`-checked against the worktree root before copying with
`dereference: false`; symlinks therefore cannot smuggle bytes from outside the
repository or redirect a write outside the destination. An escaping,
disappeared, or over-budget match is skipped individually and reported by
pattern, path, and reason in `WorktreeSetupOutcome.skippedCopies` and the
persisted bounded setup output. Per-entry and aggregate copies share the
512 MiB `WORKTREE_INCLUDE_MAX_TOTAL_BYTES` ceiling.

The command receives the Conductor-style environment from
`worktreeSetupEnvironment`: `BRAINSTRIKE_ROOT_PATH`,
`BRAINSTRIKE_WORKSPACE_NAME`, `BRAINSTRIKE_WORKSPACE_PATH`, and
`BRAINSTRIKE_PORT`. The port is
`3000 + (sha256(worktreePath).readUInt32BE(0) % 2000)`: deterministic for one
worktree path and unlikely to collide, but NOT probed or verified free. It is a
default the setup command may honor, never a free-port allocation.

Execution is argv-based, not a shell command string. The repository script is
spawned as `/bin/sh <absolute-script-path>`; configured argv is spawned
directly. Neither path nor argv is interpolated into a command line. Stdout and
stderr are consumed to completion while their retained bytes are bounded;
overflow marks the outcome truncated and is discarded without killing the
process. A timed-out POSIX command cannot settle merely because the process
leader and inherited output pipes closed: settlement waits for the dedicated
process group to disappear, while the existing post-escalation deadline keeps
the outcome bounded. Timeout, spawn, signal, and non-zero-exit failures remain
visible but non-blocking: the worktree is usable, and the bounded
`WorktreeSetupOutcome` is returned and its status/output persisted on the ledger
row rather than dropped.
