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
user opens it, and Radix retains it through the exit animation. The permanent
orientation bar therefore starts no inventory scan. Each fresh open requests a
current inventory; this favors fresh root/trust facts over a menu-local cache.
Unresolved, loading, unavailable, empty and partial-error inventory states
stay distinct. Exact path matches provide repository hints only; a repository
below a connected parent is never mislabeled as that parent's repository. Other
discovered worktrees stay visible and disabled with the trust, containment,
lock, pruning or not-mounted reason.

Regression coverage: `git-focused-folder.test.tsx` exercises deferred discovery,
mounted-ID switching, repeated selection, keyboard selection/Escape and focus
restoration, partial errors and inventory-only paths. `git-panel.test.tsx`
checks orientation through loading/restoration, non-repository and error states,
alongside the existing root-scoped stale-status and stale-diff coverage.

Review follow-up: a focused handle with only a `rootIdByPath` lookup remains
visibly selected, but only an ID stamped on a live mounted handle can switch.
The read-only Git status hook retains its existing map fallback; it does not
grant the switcher authority. An unresolved identity after restoration stops
shows recovery guidance instead of an indefinite waiting message. Windows-shaped
paths use case-insensitive display keys, while POSIX case remains significant
because volume case sensitivity cannot be inferred safely. Discovery duplicates
use that same display key; none of these hints authorize access.
