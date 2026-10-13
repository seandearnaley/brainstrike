import {
  type BoundaryTransport,
  callBoundary,
} from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';

/**
 * The desktop preload's native window-focus capability (BST-1864), exposed as
 * `window.windowFocus` and read through this typed accessor by
 * `useAppActive()` in `@brainstrike/hooks`, which must not import desktop code.
 *
 * Desktop-only, like every preload bridge: web has no such object and keeps the
 * document's own focus. Consumers capability-check by asking for the bridge —
 * never `isElectron()`. The desktop contract
 * (`apps/desktop/src/ipc-domains/window-focus.contract.ts`) derives the exposed
 * object and pins it to this interface at compile time.
 */
export interface WindowFocusBridge {
  /** The asking window's native focus right now. */
  readonly isFocused: () => Promise<boolean>;
  /** Native focus changes; returns the unsubscribe. */
  readonly onChange: (callback: (focused: boolean) => void) => () => void;
}

/** The exposed key set; the desktop contract's keys are pinned equal to it. */
export const WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS = ['isFocused', 'onChange'] as const;

const logger = createLogger('WindowFocusBridge');

/**
 * `null` when the capability is absent (web, hidden hosts). A bridge that is
 * present but not this shape is a wiring defect: it is reported as an error and
 * treated as absent, the same rule `window.platform` follows, so the document
 * focus is never used without a signal.
 */
export function resolveWindowFocusBridge(): WindowFocusBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (
    window as Window & { windowFocus?: Partial<BoundaryTransport<WindowFocusBridge>> | null }
  ).windowFocus;
  if (candidate === undefined) {
    return null;
  }
  const missing = WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof candidate?.[method] !== 'function'
  );
  if (candidate === null || missing.length > 0) {
    logger.error('window.windowFocus bridge is malformed; using the document focus instead', {
      missing: candidate === null ? [...WINDOW_FOCUS_BRIDGE_REQUIRED_METHODS] : missing,
    });
    return null;
  }
  const transport = candidate as BoundaryTransport<WindowFocusBridge>;
  return {
    isFocused: () => callBoundary(() => transport.isFocused()),
    onChange: transport.onChange,
  };
}
