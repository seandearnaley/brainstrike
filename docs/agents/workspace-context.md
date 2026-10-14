# Workspace context and edits

## Root authority

Canonical RootId and the main-owned mounted-root registry authorize access; a
saved path, selected folder or managed worktree row alone does not. Revalidate the
same binding after awaited work. Registry add/restore/disconnect completes before
renderer projection; failed removal leaves the root connected.

Main root is the assistant's operating root; focused root is incidental UI
selection. Preserve Main ordering across restore and re-add. A terminal cwd pin
is shell-only and must not silently change assistant authority. Rebuilt handles
carry their durable root ID, not a selection/cache folder ID.

## Instructions, prompts and skills

Use the shared contained, size-bounded readers for workspace instructions,
references, commands and skills. Respect scoped precedence and hard ignore rules;
report omissions and preserve Unicode boundaries when limiting context. Never
bypass the host's privacy or token-cap policy with a raw filesystem read.

Canonical prompt revisions are immutable and use their existing owner. Client
view state does not become another prompt store. Slash commands and MCP prompts
are explicit selections, not automatic execution. External content supplies text,
not filesystem or permission authority.

Only the trusted, enabled winning skill can execute its registered script. Verify
skill/root containment, supported interpreter and declared allowed tools. Spawn
structured argv through the existing permission/process lifecycle, not a shell
string reconstructed from model input. Workspace-local skills stay bound to their
root; global skills still need an explicit mounted target.

## Writes and undo

Read-before-write is a thread-scoped compare contract. Record content-bearing
reads and successful own writes under the same per-file lock; snippets are not a
full read. Compare canonical targets inside that lock and return a typed reread
refusal on mismatch. New, unobserved or vanished files follow the existing
compare-only policy; this is not a requirement to read every new path.

The host records the first pre-edit baseline and committed attribution for each
run/path. Undo uses those baselines, refuses an active run, revalidates the root
and reports disk conflicts rather than overwriting silently. Unavailable baselines
remain visibly unavailable. Renames and multi-run undo preserve ordered, idempotent
restoration. Whole-turn shadow Git and per-edit baselines are distinct owners.
Thread deletion/reset retire the associated content through those owners.

Decision: [ADR-0016](../adr/0016-workspace-trust-and-ignore-chain.md).
Implementation: desktop workspace readers/tools, `packages/agent-host` and
`packages/file-explorer`.
