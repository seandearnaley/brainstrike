/**
 * Lightweight capability entry for the browser pane (BST-1174).
 *
 * The desktop root layout imports this at STARTUP to decide whether to surface
 * the Browser nav-rail tab. Re-exports ONLY the capability check (plus the
 * required-method pin the preload contract test consumes) from the
 * dependency-light `browser-bridge` module — it must NOT pull in the pane
 * component, so importing it does not defeat that lazy code-split.
 *
 * Mirrors `changes/availability.ts` exactly.
 */
export {
  BROWSER_BRIDGE_REQUIRED_METHODS,
  isBrowserBridgeAvailable,
  resolveBrowserBridge,
} from './browser-bridge';
