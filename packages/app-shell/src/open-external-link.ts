import { createLogger } from '@brainstrike/logging';
import { resolvePlatformBridge } from './platform-bridge';

const logger = createLogger('OpenExternalLink');

/**
 * Protocols this renderer will hand to the platform.
 *
 * Deliberately the same set the desktop main process enforces in
 * `validateExternalUrl` (apps/desktop/src/ipc-shell-handlers.ts). The main
 * process is the real trust boundary — Electron's security guide warns that
 * `shell.openExternal` with untrusted content can execute arbitrary commands —
 * so this renderer copy is a fast, user-facing check, never the enforcement.
 * Keeping ONE definition here (rather than one per calling surface) is what
 * stops the two from drifting apart.
 */
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export interface OpenLinkResult {
  readonly error?: string;
  readonly ok: boolean;
}

function validateLinkProtocol(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)
      ? null
      : `Blocked protocol: ${parsed.protocol}`;
  } catch {
    // Relative hrefs land here too: `new URL('docs/foo.ts')` throws without a
    // base. They are not openable as links, and saying so is the point.
    return 'Invalid URL';
  }
}

/**
 * Open a link outside the current view: the OS browser via the validated
 * `shell.openExternal` IPC on desktop, a new tab on web.
 *
 * The desktop path is chosen by BRIDGE PRESENCE, never `isElectron()` — a
 * malformed bridge resolves to null and the web path runs, which is the correct
 * behavior for a renderer that genuinely has no shell access.
 */
export async function openExternalLink(url: string): Promise<OpenLinkResult> {
  const protocolError = validateLinkProtocol(url);
  if (protocolError) {
    logger.warn('Blocked external link', { protocolError, url });
    return { error: protocolError, ok: false };
  }

  const bridge = resolvePlatformBridge();
  if (bridge) {
    return bridge.openExternal(url);
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  return opened ? { ok: true } : { error: 'Popup blocked by the browser', ok: false };
}
