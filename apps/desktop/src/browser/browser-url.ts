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

/** An agent navigation's target: the URL its tab loads and that URL's origin, or why it may not. */
export type AgentNavigationTarget =
  | { readonly origin: string; readonly url: string }
  | { readonly refusal: string };

/**
 * Where the agent's own navigation goes. It gets webExtract's host guard, not
 * just the pane's scheme gate: only public http(s) pages. Normalized first, so
 * the guard and the consent see exactly what the pane would load, the search
 * fallback included. The user's own URL bar is unaffected.
 */
export function agentNavigationTarget(url: string | undefined): AgentNavigationTarget {
  const normalized = normalizeUrl(url);
  const refusal = isNavigableUrl(normalized)
    ? refuseExtractUrl(normalized)
    : `refused: only http(s) pages can be opened by the agent (got "${normalized}")`;
  return refusal ? { refusal } : { origin: new URL(normalized).origin, url: normalized };
}
