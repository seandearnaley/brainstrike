/**
 * Shared Content-Security-Policy builder for the web and Electron desktop apps.
 *
 * `apps/web/src/csp-utils.ts` and `apps/desktop/src/csp-utils.ts` each used to
 * carry their own `getCSP`/`getDevCSP` copy; the two policies drifted by ~66
 * lines (BST-745). This module is the single source of truth, parameterized by
 * the `target` platform so every web-vs-electron difference below is a
 * deliberate, commented decision rather than accidental copy-paste drift. It
 * reproduces each app's exact prior output; the per-app test suites remain the
 * behavior net.
 */
// Type-only import: `index.ts` re-exports this module's `getContentSecurityPolicy`
// at runtime, so this edge must stay `import type` (erased under
// verbatimModuleSyntax) — importing a runtime value from `./index` here would
// create a real circular import.
import type { Platform } from './index.js';

export type CspEnvironment = 'development' | 'production';

interface CspDirectives {
  'base-uri': string[];
  'connect-src': string[];
  'default-src': string[];
  'font-src': string[];
  'form-action': string[];
  'frame-ancestors': string[];
  'frame-src': string[];
  'img-src': string[];
  'object-src': string[];
  'script-src': string[];
  'style-src': string[];
  'worker-src': string[];
}

function buildConnectSrc(isDev: boolean, isElectron: boolean): string[] {
  const connectSrc = ["'self'"];
  // Electron talks to its local assistant-server (bound to 127.0.0.1/localhost)
  // in BOTH dev and prod; the web build never reaches a local server in prod.
  if (isElectron && !isDev) {
    connectSrc.push('http://127.0.0.1:*', 'http://localhost:*');
  }
  if (isDev) {
    // Vite dev server + HMR websockets (both targets).
    connectSrc.push('ws://localhost:*', 'http://localhost:*');
    if (isElectron) {
      connectSrc.push('http://127.0.0.1:*');
    }
    connectSrc.push('ws://127.0.0.1:*', 'wss://localhost:*');
  }
  // Hugging Face: model-weight fetches (both targets). ONNX Runtime's WASM is the
  // app's own same-origin file, so no CDN is allowed (BST-2003).
  connectSrc.push('https://huggingface.co', 'https://*.hf.co');
  if (isElectron) {
    // Desktop calls embedding providers directly; the browser cannot (CORS), so
    // web routes them server-side and these origins stay Electron-only.
    connectSrc.push(
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
      'https://api.cohere.com',
      'https://api.voyageai.com'
    );
  }
  return connectSrc;
}

function buildImgSrc(isDev: boolean, isElectron: boolean): string[] {
  const imgSrc = ["'self'", 'data:', 'blob:'];
  if (isElectron) {
    // Electron registers the custom `brainstrike-asset:` protocol for
    // root-validated local images (markdown viewer); web has no such protocol.
    imgSrc.push('brainstrike-asset:');
  }
  if (isDev) {
    imgSrc.push('http://localhost:*');
  }
  return imgSrc;
}

function buildScriptSrc(isDev: boolean, isElectron: boolean): string[] {
  // script-src is the sharpest web-vs-electron split, and every difference is a
  // deliberate security posture:
  //  - Electron NEVER script-loads from a CDN and runs WASM on the narrower
  //    'wasm-unsafe-eval' in production (full 'unsafe-eval' stays dev-only). Its
  //    renderer holds the secrets/terminal/git bridges, so a jsdelivr compromise
  //    must not become code execution (BST-573). Since BST-2003 no directive
  //    allows jsdelivr at all.
  //  - Web production follows the same fetch-only CDN and narrow WASM policy
  //    (BST-594). Development keeps the Vite HMR sources below.
  if (isElectron) {
    return isDev
      ? [
          "'self'",
          'blob:',
          "'unsafe-inline'",
          "'unsafe-eval'",
          "'wasm-unsafe-eval'",
          'http://localhost:*',
        ]
      : ["'self'", 'blob:', "'wasm-unsafe-eval'"];
  }
  return isDev
    ? ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'http://localhost:*', 'blob:']
    : ["'self'", 'blob:', "'wasm-unsafe-eval'"];
}

function getContentSecurityPolicyDirectives(env: CspEnvironment, target: Platform): CspDirectives {
  const isDev = env === 'development';
  const isElectron = target === 'electron';

  return {
    'base-uri': ["'self'"],
    'connect-src': buildConnectSrc(isDev, isElectron),
    'default-src': isDev ? ["'self'", 'http://localhost:*', 'ws://localhost:*'] : ["'self'"],
    'font-src': isDev ? ["'self'", 'data:', 'http://localhost:*'] : ["'self'", 'data:'],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    // Only host-authored sandbox shells are ever framed. Electron serves two,
    // each from its own privileged scheme with a header-delivered CSP that
    // setup-security exempts from the global stamp: the Canvas shell
    // (brainstrike-canvas:, BST-1173) and the per-mount MCP App sandbox shell
    // (brainstrike-mcp-app:, BST-1572). Web serves the canvas shell
    // same-origin at /canvas-frame.html with per-path headers and has no MCP
    // App host. blob: is deliberately absent: a blob shell would run on the
    // host origin with no header CSP at all. Explicit frame-src also stops
    // frames from falling back to default-src (which would otherwise allow
    // arbitrary localhost frames in dev).
    'frame-src': isElectron ? ['brainstrike-canvas:', 'brainstrike-mcp-app:'] : ["'self'"],
    'img-src': buildImgSrc(isDev, isElectron),
    'object-src': ["'none'"],
    'script-src': buildScriptSrc(isDev, isElectron),
    'style-src': isDev
      ? ["'self'", "'unsafe-inline'", 'http://localhost:*']
      : ["'self'", "'unsafe-inline'"],
    'worker-src': ["'self'", 'blob:'],
  };
}

/** Join the directive map into a single Content-Security-Policy header string. */
function directivesToString(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(' ')}`)
    .join('; ');
}

/**
 * Build the Content-Security-Policy header string for the given environment and
 * platform target. Primary entry point for the Vite dev server (development) and
 * the Electron session / production shells.
 */
export function getContentSecurityPolicy(env: CspEnvironment, target: Platform): string {
  return directivesToString(getContentSecurityPolicyDirectives(env, target));
}
