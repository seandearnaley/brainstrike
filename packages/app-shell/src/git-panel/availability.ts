/**
 * Lightweight capability entry for the Git panel.
 *
 * The desktop root layout imports this at STARTUP to decide whether to surface
 * the Git tab. It deliberately re-exports ONLY the capability check (plus the
 * required-method pin the desktop preload contract test consumes) from the
 * dependency-light `git-bridge` module — it must NOT pull in `GitPanel`
 * (which imports `@brainstrike/ui` + `@codemirror/merge`), so importing it does
 * not defeat the lazy code-split in `git-page-content.tsx`.
 */
export {
  GIT_BRIDGE_REQUIRED_METHODS,
  isGitBridgeAvailable,
  resolveGitBridge,
} from './git-bridge';
