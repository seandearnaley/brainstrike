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

/** A loopback literal's `host:port`, as the proxy keys a CONNECT or absolute-form target. */
function loopbackAuthority(url: URL): string | undefined {
  if (
    !LOOPBACK_HOSTS.has(url.hostname) ||
    (url.protocol !== 'http:' && url.protocol !== 'https:')
  ) {
    return;
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return `${url.hostname.replace(/^\[(.*)\]$/, '$1')}:${port}`;
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
  const loopback = parsed === undefined ? undefined : loopbackAuthority(parsed);
  if (parsed !== undefined && loopback !== undefined) {
    return parsed.username || parsed.password
      ? { refusal: 'refused: URLs with embedded credentials are never opened by the agent' }
      : { loopback, origin: parsed.origin, url: normalized };
  }
  const refusal = refuseExtractUrl(normalized);
  return refusal ? { refusal } : { origin: new URL(normalized).origin, url: normalized };
}
