# Managed worktree ledger omissions — evidence

Supports `docs/agents/database.md` § "MANAGED WORKTREE LEDGER".

Migration 109's ledger and the three deliberate omissions (no `root_id`, no FKs and not a thread-delete sidecar, not in the assistant schema probe), each load-bearing. Read before adding a column or a cascade here.

The record below is the original contract text, extracted unchanged.

`brainstrike_worktrees` records every linked git worktree BrainStrike itself
created (`created_by IN ('agent','user')`), keyed by its `path` (UNIQUE) and
its realpath'd `repo_common_dir`. It is the authorization source for the ONE
sanctioned picker-less root mount besides recents (`isManagedWorktreePath` →
`isAuthorizedWorktreeMountPath`, `worktree-adopt.ts`; a live row must also be
reachable per adoption's `assertReachable` rule — see
`docs/agents/workspace-context.md`) and the provenance source the git inventory joins
to produce `'both'` / `'agent-reported'`. Setup outcomes persist their closed
status, bounded output, and nullable user-facing reason so later inventory
reads can explain failed or skipped setup without reconstructing create-time
state.

Boot-time root reconciliation reads active ledger identities through
`WorktreeService.listManagedPaths()`, which returns only `{ id, path }` and
deliberately does not resolve git inventory or workspace-root containment.
`WorktreeService.list()` remains the full inventory-joined UI surface.

Deliberate omissions, all load-bearing:

- **No `root_id`.** The durable `roots.id` is derived by path from the live
  `roots` table in `WorktreeService.list`; a stored copy goes stale the moment
  the folder is disconnected.
- **No foreign keys, and NOT in `THREAD_DELETE_SIDECAR_TABLES`.** A worktree
  outlives its thread on purpose — cascading it would orphan a directory of
  uncommitted work. Thread delete offers "also archive its worktree" instead.
- **Not part of the assistant memory schema probe.** That probe covers the
  relations the assistant repository reads or writes — the run tables plus every
  registered thread-delete sidecar (BST-1651).

Registered in both runners and in `BRAINSTRIKE_RESET_TABLES`. Factory reset
clears the ROWS; deleting the worktree DIRECTORIES is a separate, explicitly
confirmed step (see `platform-contracts.md`).

Any migration merged to a long-lived branch counts as shipped and must never be amended in place, because execution on a shared branch cannot be disproven even if no production profile is known to have run it. Corrections must use a new, additive, forward-only migration; `112-worktree-setup-reason.ts` is the concrete example.
