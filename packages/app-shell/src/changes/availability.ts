/**
 * Lightweight capability entry for the Changes surface (BST-1114).
 *
 * The desktop root layout imports this at STARTUP to decide whether to surface
 * the Changes tab at all. It deliberately re-exports ONLY the capability check
 * (plus the required-method pin the desktop preload contract test consumes)
 * from the dependency-light `changes-bridge` module — it must NOT pull in
 * `ChangesSurface` (which imports `@brainstrike/ui` + the diff renderer), so
 * importing it does not defeat the lazy code-split in `changes-page-content.tsx`.
 *
 * Mirrors `git-panel/availability.ts` exactly; see that file for the rationale.
 */

export type {
  ChangesBridge,
  RewindApplyPayload,
  RewindFinalizePayload,
  RewindPreviewPayload,
  RewindRedoPayload,
} from './changes-bridge';
export {
  CHANGES_BRIDGE_REQUIRED_METHODS,
  isChangesBridgeAvailable,
  resolveChangesBridge,
} from './changes-bridge';
