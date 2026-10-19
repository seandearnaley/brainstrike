/**
 * The URLs the embedded browser pane loads (BST-1174) and the ones the agent
 * may open (BST-1178). A leaf module without Electron: Main's pane and the
 * agent host's origin consent share it, so the origin a person answers for is
 * the one the agent's tab opens.
 */
import { refuseExtractUrl } from '@brainstrike/host-capabilities/extract-url-refusal';

/** Explicit `scheme://authority` at the START of the string (not a substring). */
const HIERARCHICAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `about:` / `data:` a user may type; NO `file:`/`devtools:`/`chrome:`/`blob:`. */
const PRESERVED_SCHEME = /^(about|data):/i;
/** A bare host: a dotted name, `localhost`, or an explicit `host:port`. */
const BARE_HOST = /^(localhost|[^\s/]+\.[^\s/]+|[^\s/]+:\d+)(\/|$|\?|#)/i;
/** DuckDuckGo query fallback for input that is neither a URL nor a host. */
const SEARCH_PREFIX = 'https://duckduckgo.com/?q=';

/**
 * Normalize URL-bar / popup input to a loadable URL:
 * - blank → `about:blank`
 * - explicit `scheme://…` or `about:`/`data:` → preserved
 * - a bare host (`example.com`, `localhost:3000`) → `https://…`
 * - anything else (`what is rust`) → a search query
 *
 * Dangerous schemes (`file:`, `devtools:`, `chrome:`, `blob:`, `view-source:`)
 * are deliberately NOT preserved — {@link isNavigableUrl} is the final gate.
 */
export function normalizeUrl(url: string | undefined): string {
  const trimmed = url?.trim();
  if (!trimmed) {
    return 'about:blank';
  }
  if (HIERARCHICAL_SCHEME.test(trimmed) || PRESERVED_SCHEME.test(trimmed)) {
    return trimmed;
  }
  if (BARE_HOST.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `${SEARCH_PREFIX}${encodeURIComponent(trimmed)}`;
}

/** Schemes the pane will actually load — everything else is refused. */
const NAVIGABLE_SCHEME = /^(https?|about|data):/i;

/**
 * Final navigation gate (also applied to attacker-controlled popup urls). Only
 * http/https/about/data reach the web engine; `file:`, `devtools:`, `chrome:`,
 * `blob:`, `chrome-extension:` and anything else are refused, so a page can
 * never pivot the pane into reading the local filesystem or privileged UIs.
 */
export function isNavigableUrl(url: string): boolean {
  return NAVIGABLE_SCHEME.test(url.trim());
}

/**
 * The loopback hosts a person may approve the agent opening (BST-1178), each
 * at one exact port: a local dev server. Only these literals: a name that
 * merely resolves to loopback, another 127/8 address, the LAN and link-local
 * stay refused.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An agent navigation's target: the URL its tab loads and that URL's origin,
 * with the `host:port` the egress proxy must admit when it is a loopback
 * server, or why the agent may not open it.
 */
export type AgentNavigationTarget =
  | { readonly loopback?: string; readonly origin: string; readonly url: string }
  | { readonly refusal: string };

/** Each scheme a loopback server answers on, and its default port. */
const LOOPBACK_SCHEME_PORTS: ReadonlyMap<string, string> = new Map([
  ['http:', '80'],
  ['https:', '443'],
  ['ws:', '80'],
  ['wss:', '443'],
]);

/**
 * A loopback literal's `host:port`, as the proxy keys a CONNECT or
 * absolute-form target; undefined for any other URL. WebSocket URLs count, so
 * a dev server's live-reload socket is the same server.
 */
export function loopbackAuthorityOf(url: string | URL): string | undefined {
  const parsed = typeof url === 'string' ? (URL.canParse(url) ? new URL(url) : undefined) : url;
  const defaultPort = parsed === undefined ? undefined : LOOPBACK_SCHEME_PORTS.get(parsed.protocol);
  if (parsed === undefined || defaultPort === undefined || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return;
  }
  return `${parsed.hostname.replace(/^\[(.*)\]$/, '$1')}:${parsed.port === '' ? defaultPort : parsed.port}`;
}

/**
 * BST-1178: the one loopback server an agent navigation may reach, and from
 * where: the tab it opened in, and only that page's own requests.
 */
export interface LoopbackAdmission {
  /** The `host:port` the egress proxy admits. */
  readonly authority: string;
  /** The approved origin, the only initiator its requests may come from. */
  readonly origin: string;
  /** The agent tab the navigation opens in. */
  readonly webContentsId: number;
}

/** The slice of a request the admission is checked against. */
export interface LoopbackRequest {
  readonly initiatorOrigin?: string | undefined;
  readonly resourceType: string;
  readonly url: string;
  readonly webContentsId?: number | undefined;
}

/**
 * Whether Main lets an agent-tab request through to the proxy. Only a request
 * for the admitted server is decided here: it passes from the admitted tab,
 * as the main-frame load the agent started or as the approved page's own
 * request. A public page fetching or redirecting there, in any tab, is
 * cancelled; every other target is the proxy's to decide.
 */
export function loopbackRequestAllowed(
  request: LoopbackRequest,
  admission: LoopbackAdmission | null
): boolean {
  if (admission === null || loopbackAuthorityOf(request.url) !== admission.authority) {
    return true;
  }
  if (request.webContentsId !== admission.webContentsId) {
    return false;
  }
  return request.initiatorOrigin === undefined
    ? request.resourceType === 'mainFrame'
    : request.initiatorOrigin === admission.origin;
}

/**
 * Where the agent's own navigation goes. It gets webExtract's host guard, not
 * just the pane's scheme gate: public http(s) pages, and a loopback server
 * (named by {@link LOOPBACK_HOSTS}) that the agent host asked a person about.
 * Normalized first, so the guard and the consent see exactly what the pane
 * would load, the search fallback included. The user's own URL bar is
 * unaffected.
 */
export function agentNavigationTarget(url: string | undefined): AgentNavigationTarget {
  const normalized = normalizeUrl(url);
  if (!isNavigableUrl(normalized)) {
    return {
      refusal: `refused: only http(s) pages can be opened by the agent (got "${normalized}")`,
    };
  }
  const parsed = URL.canParse(normalized) ? new URL(normalized) : undefined;
  const loopback =
    parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      ? undefined
      : loopbackAuthorityOf(parsed);
  if (parsed !== undefined && loopback !== undefined) {
    return parsed.username || parsed.password
      ? { refusal: 'refused: URLs with embedded credentials are never opened by the agent' }
      : { loopback, origin: parsed.origin, url: normalized };
  }
  const refusal = refuseExtractUrl(normalized);
  return refusal ? { refusal } : { origin: new URL(normalized).origin, url: normalized };
}
