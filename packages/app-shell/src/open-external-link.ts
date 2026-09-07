import type { AssistantLinkOpenResult } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
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

export type OpenLinkResult = AssistantLinkOpenResult;

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open a link outside the current view: the OS browser via the validated
 * `shell.openExternal` IPC on desktop, a new tab on web.
 *
 * The desktop path is chosen by BRIDGE PRESENCE, never `isElectron()` — a
 * malformed bridge resolves to null and the web path runs, which is the correct
 * behavior for a renderer that genuinely has no shell access.
 *
 * Never rejects. Every caller turns a non-ok result into a visible message, so
 * a rejection escaping here would land as a silent dead click — the exact
 * failure this seam exists to remove.
 */
export async function openExternalLink(url: string): Promise<OpenLinkResult> {
  const protocolError = validateLinkProtocol(url);
  if (protocolError) {
    logger.warn('Blocked external link', { protocolError, url });
    return { error: protocolError, ok: false };
  }

  const bridge = resolvePlatformBridge();
  if (bridge) {
    try {
      // The IPC contract resolves { ok, error }, but the CHANNEL can fail — a
      // torn-down window or a main-process throw rejects instead.
      return await bridge.openExternal(url);
    } catch (error) {
      logger.error('Shell bridge failed to open link', { error, url });
      return { error: toErrorMessage(error), ok: false };
    }
  }

  try {
    // Per the HTML standard's window-open steps, `noopener` with a `_blank`
    // target returns null EVEN WHEN THE WINDOW OPENED, so the return value
    // carries no success signal and must not be read as one — doing so would
    // toast "Could not open link" on every successful web link. `noopener`
    // stays: dropping it to regain a return value would hand the opened page a
    // reference back to this window. A blocked popup surfaces as a throw.
    window.open(url, '_blank', 'noopener,noreferrer');
    return { ok: true };
  } catch (error) {
    logger.error('Browser refused to open link', { error, url });
    return { error: toErrorMessage(error), ok: false };
  }
}
