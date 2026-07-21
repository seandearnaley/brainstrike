# BST-604 — clear repository Ultracite warnings

## Goal

Clear the six known repository warnings without changing runtime behavior.

## Plan

1. Reproduce all six warnings on current `origin/main`.
2. Remove three suppressions whose target diagnostics no longer exist.
3. Inspect the three effect warnings and suppress only the exact intentional
   local lifecycle effects; do not introduce remote-query abstractions.
4. Require `pnpm dlx ultracite check` to report zero warnings and zero errors.
5. Run affected type-check/tests before publishing the isolated cleanup.
