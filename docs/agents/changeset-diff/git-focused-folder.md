# Git Focused-folder orientation

Supports `docs/agents/changeset-diff.md` § "Git panel (`packages/app-shell/src/git-panel/`) — converged in W6".

BST-1897 (2026-09-30) makes the inspected folder visible in every Git panel
state. A restored non-Git parent alongside a mounted Git child can legitimately
leave Git showing the parent's non-repository result. That observation alone
does not establish a restoration defect, and this UX is cross-platform.

The switcher passes a currently mounted handle's durable identity to the
existing `setFocusedRoot` seam. It never changes Main, opens an arbitrary path,
or broadens a grant. Connected folders remain selectable when inventory
inspection fails: mounting already grants their access, and a later scoped Git
status read determines whether the selected folder is a repository.

Repository discovery is owned by the menu content, which mounts only while the
user opens it. The permanent orientation bar therefore starts no inventory
scan. Unresolved, loading, unavailable, empty and partial-error inventory states
stay distinct. Exact path matches provide repository hints only; a repository
below a connected parent is never mislabeled as that parent's repository. Other
discovered worktrees stay visible and disabled with the trust, containment,
lock, pruning or not-mounted reason.

Regression coverage: `git-focused-folder.test.tsx` exercises deferred discovery,
mounted-ID switching, repeated selection, keyboard selection/Escape and focus
restoration, partial errors and inventory-only paths. `git-panel.test.tsx`
checks orientation through loading/restoration, non-repository and error states,
alongside the existing root-scoped stale-status and stale-diff coverage.
