# Renderer-fallback expand-all batching — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before changing display-commit batching in `use-lazy-file-tree`, or before arming batching for the worker fast path.

Extracted verbatim from the pre-distillation contract.

---

  directory results — loaded children AND load errors — buffer in
  `use-lazy-file-tree` and publish once per traversal batch through the
  session's `onBatchLoadsSettled` boundary (before discovery reads), plus on
  cancellation and session end. Per-directory `'loading'` display commits are
  suppressed while the session runs — each `commitNormalizedTree` is an
  O(tree) clone+materialize, so per-directory commits are
  O(tree × directories). Batching is armed ONLY for the renderer session
  (`rendererExpandAllSessionRef`): the worker fast path keeps per-directory
  commits, because buffering a manual load resolved during a worker expand-all
  would let the session-end flush clobber worker-loaded deep subtrees with
  stale shallow children. Pinned by
  `use-lazy-file-tree-expand-all-batching.test.ts`,
  `use-lazy-file-tree-expand-all-worker-interplay.test.ts`, and the
  `onBatchLoadsSettled` ordering test in `direct-directory-traversal.test.ts`.

