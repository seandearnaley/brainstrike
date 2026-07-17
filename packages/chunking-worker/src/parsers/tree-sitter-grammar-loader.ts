/**
 * Lazy loader + per-language cache for tree-sitter grammar WASM bytes.
 *
 * Why this lives in its own file:
 *  - The adapter shouldn't care WHERE the grammar bytes come from. In Node
 *    (vitest, scripts), they're a file under `grammars/`. In the browser /
 *    Web Worker (production), they come from `/assets/grammars/` after Vite's
 *    static-copy plugin moves them at build time. The loader abstracts both.
 *  - Per-language caching (one `Language` per process per language) means
 *    the ~10-30 ms WASM-instantiate cost is paid once per worker lifetime.
 *    Subsequent parses reuse the cached `Language`.
 *
 * web-tree-sitter init is two-phase:
 *   1. `Parser.init({ locateFile })` initializes the Emscripten runtime
 *      (loads `web-tree-sitter.wasm`). MUST run exactly once per process.
 *   2. `Language.load(bytes)` loads a per-language grammar from raw bytes
 *      (each call returns a NEW Language; cache to avoid re-loading).
 *
 * Both `parserInitPromise` and the `languageCache` are module-level globals
 * so that even multiple `treeSitterAdapter('python')` factory calls share
 * the same underlying instances.
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §3.3
 */

import { Language, Parser } from 'web-tree-sitter';
import type { TreeSitterLanguage } from './tree-sitter-adapter';

/** Module-level: ensure `Parser.init()` runs at most once per process. */
let parserInitPromise: Promise<void> | null = null;

/** Per-language cache: one Language instance per language string. */
const languageCache = new Map<TreeSitterLanguage, Promise<Language>>();

/**
 * Resolve the wasm bytes for a given grammar.
 *
 * In Node (tests, scripts): read from the vendored file under
 * `packages/chunking-worker/grammars/<lang>.wasm`.
 *
 * In a browser / Web Worker (production): fetch from
 * `/assets/grammars/<lang>.wasm` — apps copy the same vendored file there
 * via Vite's static-copy plugin at build time (Phase 4).
 *
 * Both paths return a `Uint8Array` of the wasm bytes for
 * `Language.load(bytes)`. We deliberately don't use `Language.load(URL)`:
 *  - In Node, URLs require `fileURLToPath` gymnastics around Emscripten's
 *    locateFile resolution.
 *  - Going through bytes is one well-tested code path that works in both
 *    environments and lets tests inject their own bytes for grammar
 *    mocking if ever needed.
 */
async function loadGrammarBytes(language: TreeSitterLanguage): Promise<Uint8Array> {
  if (typeof window === 'undefined' && typeof self === 'undefined') {
    // Node environment (vitest, scripts). Read from vendored grammars dir.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const wasmPath = path.join(here, '..', '..', 'grammars', `${language}.wasm`);
    return new Uint8Array(await readFile(wasmPath));
  }
  // Browser / Web Worker. Apps put grammars under <base>/assets/grammars/.
  //
  // Resolve relative to the worker module's OWN URL (import.meta.url) rather
  // than using an absolute `/assets/...` path. Reasons:
  //  - apps/web serves from the document root, so /assets/... happens to work
  //  - apps/desktop runs under file:// with `base: './'` in vite.config; an
  //    absolute `/assets/...` resolves to file:///assets/... — wrong path
  //  - Vite's static-copy plugin (Phase 4) puts grammars under the same
  //    /assets/ dir as the worker bundle. `./grammars/<lang>.wasm` relative
  //    to a worker URL like `<base>/assets/chunking-worker-XYZ.js` resolves
  //    correctly in BOTH environments.
  //
  // P1 fix (review comment on #1000): absolute path crashed Electron.
  //
  // CRITICAL — do NOT inline `import.meta.url` into the `new URL(...)` call.
  // Vite's asset plugin matches `new URL(<literal>, import.meta.url)` (regex
  // `assetImportMetaUrlRE`, second arg must be the literal `import.meta.url`).
  // Our first arg is a DYNAMIC template (`${language}`), so Vite takes its
  // dynamic branch and rewrites this into an EMPTY glob-map lookup —
  // `new URL(Object.assign({})[`./grammars/${language}.wasm`], import.meta.url)`
  // — because the grammar WASM files ship via `viteStaticCopy`, NOT the module
  // graph, so the glob matches nothing. That yields `undefined`, so the fetch
  // URL becomes `<base>/assets/undefined` → 404 → grammar load throws → the
  // tree-sitter adapter throws → portable-chunking SILENTLY degrades code
  // chunking to recursive text splitting (violating the no-silent-fallback
  // rule). Routing `import.meta.url` through a variable breaks the regex match
  // so the URL is resolved at RUNTIME against the worker's own bundle URL,
  // where `viteStaticCopy` has placed `assets/grammars/<lang>.wasm`.
  const moduleUrl = import.meta.url;
  const grammarUrl = new URL(`./grammars/${language}.wasm`, moduleUrl).href;
  const response = await fetch(grammarUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch grammar for ${language} at ${grammarUrl}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Initialize the web-tree-sitter runtime exactly once per process.
 *
 * In Node, web-tree-sitter handles its own wasm-loading via its bundled
 * `web-tree-sitter.wasm`. In the browser, the same default works as long
 * as the bundler ships the runtime wasm alongside the JS — Vite handles
 * this when we `import { Parser } from 'web-tree-sitter'`.
 */
function initParser(): Promise<void> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init();
  }
  return parserInitPromise;
}

/**
 * Get (or lazily load) the Language for a given grammar.
 * Cached per-language so the WASM instantiate cost is paid at most once
 * per process per language.
 *
 * P1 fix (review comment on #1000): if the underlying load REJECTS (network
 * blip, missing asset, corrupt wasm), the rejected promise must be evicted
 * from the cache. The original code stored the in-flight promise, never
 * cleaned it up on failure, and every subsequent `loadLanguage('python')`
 * returned the same rejected promise — permanently breaking Python
 * chunking until the worker restarted. Now: on rejection, drop the entry
 * so the next call retries cold.
 */
export async function loadLanguage(language: TreeSitterLanguage): Promise<Language> {
  await initParser();
  let cached = languageCache.get(language);
  if (!cached) {
    cached = (async () => {
      const bytes = await loadGrammarBytes(language);
      return Language.load(bytes);
    })();
    cached.catch(() => {
      // Evict failed entry so the next attempt isn't permanently poisoned.
      // The check guards against racing entries: if another caller already
      // replaced the cache with a new attempt, leave it alone.
      if (languageCache.get(language) === cached) {
        languageCache.delete(language);
      }
    });
    languageCache.set(language, cached);
  }
  return cached;
}

/**
 * Reset the loader's caches. Test-only helper — production code should
 * never call this. Useful when tests want to exercise the cold-init path.
 */
export function resetLoaderForTests(): void {
  parserInitPromise = null;
  languageCache.clear();
}
