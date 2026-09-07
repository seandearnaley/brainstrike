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

/**
 * Outcome of a link open.
 *
 * Defined HERE, not imported from `@brainstrike/assistant-ui`: this helper also
 * backs the file-explorer markdown preview, and a generic renderer utility must
 * not take its result type from the assistant package. The assistant contract
 * declares a structurally identical shape of its own.
 */
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
    // Relative (`docs/foo.ts`) and protocol-relative (`//host/path`) hrefs both
    // land here: `new URL()` throws without a base. Naming the real reason
    // beats "Invalid URL", which reads as "this link is malformed" for a
    // reference that is merely not absolute.
    return 'Link is not an absolute URL';
  }
}

/** Never throws: it is called from inside catch blocks on a path that promises
 * not to reject, and a hostile value (a null-prototype object, a throwing
 * `Symbol.toPrimitive`) would otherwise take the whole seam down. */
function toErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown error';
  }
}

/** The bridge crosses an IPC boundary, so its reply is untyped data at runtime:
 * a mangled or `undefined` payload would make callers throw on `result.ok`. */
function normalizeBridgeResult(value: unknown, url: string): OpenLinkResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OpenLinkResult).ok === 'boolean'
  ) {
    return value as OpenLinkResult;
  }
  logger.error('Shell bridge returned an unexpected result shape', { url, value });
  return { error: 'Shell bridge returned an unexpected result', ok: false };
}

/**
 * Open a link outside the current view: the OS browser via the validated
 * `shell.openExternal` IPC on desktop, a new tab on web.
 *
 * The desktop path is chosen by BRIDGE PRESENCE, never `isElectron()` — a
 * malformed bridge resolves to null and the web path runs, which is the correct
 * behavior for a renderer that genuinely has no shell access.
 *
 * NEVER REJECTS, and that is load-bearing rather than aspirational: every
 * caller turns a non-ok result into the one visible failure message, so a
 * rejection escaping here lands as a silent dead click — the exact failure this
 * seam exists to remove. Hence the result-shape normalization and the
 * non-throwing error formatter above.
 */
export async function openExternalLink(url: string): Promise<OpenLinkResult> {
  try {
    const protocolError = validateLinkProtocol(url);
    if (protocolError) {
      logger.warn('Blocked external link', { protocolError, url });
      return { error: protocolError, ok: false };
    }

    const bridge = resolvePlatformBridge();
    if (bridge) {
      // The IPC contract resolves { ok, error }, but the CHANNEL can fail — a
      // torn-down window or a main-process throw rejects instead.
      return normalizeBridgeResult(await bridge.openExternal(url), url);
    }

    // Per the HTML standard's window-open steps, `noopener` with a `_blank`
    // target returns null EVEN WHEN THE WINDOW OPENED, so the return value
    // carries no success signal and must not be read as one — doing so toasted
    // "Could not open link" on every successful web link.
    //
    // The honest consequence: with `noopener` the outcome is UNOBSERVABLE. A
    // popup blocker returns null too (it does not throw), so a blocked popup is
    // indistinguishable from success and reports ok. That is accepted — these
    // calls run inside a user-activation handler, where blocking is unlikely —
    // and it is strictly better than the false positive it replaced. `noopener`
    // stays regardless: dropping it to regain a return value would hand the
    // opened page a reference back to this window.
    window.open(url, '_blank', 'noopener,noreferrer');
    return { ok: true };
  } catch (error) {
    logger.error('Failed to open link', { error, url });
    return { error: toErrorMessage(error), ok: false };
  }
}
