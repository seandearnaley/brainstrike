import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WindowChordCapability');

interface DesktopLifecycleBridge {
  readonly noteReloadIntent: (reason: string) => Promise<void>;
}

/**
 * Whether the renderer may claim the chords a browser reserves for its own
 * tabs and windows: ⌘/Ctrl+W, ⌘/Ctrl+Shift+T and Ctrl+Tab (BST-1842).
 *
 * The capability is the desktop `window.desktopLifecycle` bridge: it exists
 * only when the Brainstrike app, not a browser, owns this window's lifecycle.
 * Web never defines it. A present-but-malformed bridge is logged and treated
 * as absent. Resolve once: the preload runs before React mounts.
 */
export function canClaimWindowChords(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const bridge = (window as Window & { desktopLifecycle?: Partial<DesktopLifecycleBridge> })
    .desktopLifecycle;
  if (bridge === undefined) {
    return false;
  }
  if (typeof bridge.noteReloadIntent !== 'function') {
    logger.error('window.desktopLifecycle bridge is malformed; desktop tab chords disabled');
    return false;
  }
  return true;
}
