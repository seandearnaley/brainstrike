# BST-629: Prune Python environments from balanced workspace indexing

## Finding

The visible Explorer loads directories lazily. The deep `read-dir` warnings come
from the recursive Workspace Index scan, which already owns a user-selectable
`balanced` / `full-root` traversal policy.

## Contract

- Balanced indexing prunes `.venv`, `venv`, `env`, and `__pycache__` before a
  recursive directory read is scheduled.
- Full root remains the explicit opt-in override and continues to traverse those
  names; its Settings description must say that Python environments are included.
- Existing custom Explorer include/exclude filters are untouched.
- The Explorer contract document records the source of truth and override.

## Red/green proof

1. Add policy tests for all four names and the full-root override.
2. Add a walker test proving the balanced policy prevents adapter reads beneath
   virtualenv/cache directories.
3. Add the balanced exclusions and update visible policy copy and docs.
4. Run focused tests, then the repository lint/type-check/build/test gate once.
5. Profile a multi-root Desktop workspace through CDT and confirm the recursive
   scan no longer reads inside a Python environment under Balanced.
