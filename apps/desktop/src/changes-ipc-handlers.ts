/**
 * Main-process handlers for the desktop `changes` IPC domain (BST-1113).
 *
 * `resolveView` resolves any `Changeset` (agent-run / run-range / git-scope)
 * to an eager `ChangesetView`; `fileDiff` loads one file's
 * `StructuredFileDiff` lazily. Both accept `unknown` renderer-supplied
 * arguments (the IPC boundary is untrusted, same as `git-ipc-handlers.ts`).
 *
 * This file is a TYPED STUB: Task 3 lands `ChangesetDiffService` and Task 4
 * wires it in here, replacing every branch below. Until then every call
 * returns a visible `not-implemented` `GitResult` failure — never a silent
 * success, never a thrown bare `Error`. This scaffold does not merge alone;
 * Tasks 3+4 replace the stub bodies within the same PR.
 */
import type { ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';

function notImplemented<T>(channel: string): GitResult<T> {
  return {
    error: `not-implemented: ${channel} has no handler yet (BST-1113 lands it in Task 3/4)`,
    ok: false,
  };
}

export interface ChangesIpcHandlers {
  readonly fileDiff: (
    rootId: unknown,
    changeset: unknown,
    path: unknown
  ) => Promise<GitResult<StructuredFileDiff>>;
  readonly resolveView: (rootId: unknown, changeset: unknown) => Promise<GitResult<ChangesetView>>;
}

/** Create the `changes` IPC handlers. Stubbed until Task 3/4 land the real service. */
export function createChangesIpcHandlers(): ChangesIpcHandlers {
  return {
    fileDiff: (_rootId: unknown, _changeset: unknown, _path: unknown) =>
      Promise.resolve(notImplemented<StructuredFileDiff>('changes:fileDiff')),
    resolveView: (_rootId: unknown, _changeset: unknown) =>
      Promise.resolve(notImplemented<ChangesetView>('changes:resolveView')),
  };
}
