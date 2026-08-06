/**
 * PATH SHAPE translation shared by every snapshot-engine consumer of journal
 * rows (BST-1164 W7): journal rows record NORMALIZED workspace paths with a
 * leading slash (`/src/a.ts` — `resolveWorkspaceWritePath.workspacePath`),
 * while the shadow-git tree, structured diffs, and the restore seam all use
 * root-relative paths (`src/a.ts`). Both the checkpoint undo engine
 * (`checkpoint-snapshot-undo.ts`) and the changeset view's attribution join
 * (`changeset-snapshot-view.ts`) must translate through THIS one helper — a
 * private copy in one module left the other comparing `/src/a.ts` to
 * `src/a.ts`, which silently un-attributed every tool edit in production.
 *
 * Deliberately a leaf module: the undo engine imports the view module (run
 * anchors), so hosting the helper in either of them would create a cycle
 * (the module-scope chunk-init class).
 */

/** Journal workspace path (`/src/a.ts`) → root-relative path (`src/a.ts`).
 * A path that is already root-relative passes through unchanged. */
export function snapshotRelativePath(workspacePath: string): string {
  return workspacePath.replace(/^\/+/, '');
}
