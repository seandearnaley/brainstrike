# Delegated child checkpoint baselines — evidence

Supports `docs/agents/changeset-diff.md` § "Delegated child checkpoint baselines".
Read before changing delegated admission capture, child checkpoint identity, or the shared Revert control's resolution.

The lines below are the pre-distillation contract text, extracted verbatim.

Delegated admission captures a child-scoped turn-start row in the existing
workspace snapshot ledger before native execution. Its run ID is initially
null; the existing timestamp brackets associate subsequent child host legs.
Resume does not replace the baseline, and existing runs without a baseline
remain visibly unavailable. Capture failures retain the ordinary sentinel.
Child tool checkpoints carry the child's durable run/thread/resource identity,
so the shared Revert control resolves that child's snapshot and existing disk
conflict gate. No automatic Git merge or commit is performed in the user checkout.

`delegated-workspace-snapshot.integration.test.ts` and the real Electron worker
undo case pair this contract with recovery, attribution and unrelated-file
preservation checks. The parent `undoCheckpointRun` integration case restores
only parent journaled paths and preserves child effects and independent user files.
Full conversation rewind retains its existing preview/acknowledgment semantics;
this change does not silently narrow or broaden that operation.
