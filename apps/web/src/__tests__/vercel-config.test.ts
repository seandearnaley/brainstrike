import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCanvasSandboxContentSecurityPolicy } from '@brainstrike/platform-utils';
import { describe, expect, it } from 'vitest';
import { getCSP } from '../csp-utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface VercelHeaderRule {
  readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly source: string;
}

interface VercelConfig {
  readonly functions?: Readonly<
    Record<
      string,
      {
        readonly maxDuration?: number;
        readonly supportsCancellation?: boolean;
      }
    >
  >;
  readonly headers?: readonly VercelHeaderRule[];
}

interface WebPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

interface VercelFunctionTsconfig {
  readonly compilerOptions?: {
    readonly emitDeclarationOnly?: boolean;
    readonly module?: string;
    readonly moduleResolution?: string;
    readonly verbatimModuleSyntax?: boolean;
  };
  readonly extends?: string;
}

function readVercelConfig(): VercelConfig {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8')
  ) as VercelConfig;
}

/**
 * The app-wide rule EXCLUDES the Canvas shell via negative lookahead, so
 * exactly one CSP rule matches any given path. This removes the dependency on
 * Vercel's undocumented behavior for duplicate header keys across matching
 * rules — if both CSPs were emitted, browsers would intersect them, which is
 * precisely the failure the canvas per-path policy exists to prevent
 * (review finding on PR #2290).
 */
const APP_SHELL_SOURCE = String.raw`/((?!canvas-frame\.html$).*)`;

const REVALIDATE = 'public, max-age=0, must-revalidate';
const CACHE_HEADER_KEYS = ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control'];
/** Every source that sets a cache header today; none of them can match the app shell. */
const REVIEWED_CACHE_SOURCES = [
  '/canvas-frame.html',
  '/assets/(.*)',
  '/assets/grammars/(.*)',
  '/assets/pglite.wasm',
];
const IMMUTABLE = 'public, max-age=31536000, immutable';

function cacheControlOf(rule: VercelHeaderRule): string | undefined {
  return rule.headers.find((header) => header.key.toLowerCase() === 'cache-control')?.value;
}

function headerValueOf(rule: VercelHeaderRule, key: string): string | undefined {
  return rule.headers.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value;
}

/**
 * Production cache contract. Vite content-hashes emitted assets under
 * /assets/, so those are immutable — BUT two things under /assets/ keep
 * STABLE names across deploys and must keep revalidating or a deploy that
 * changes their contents would be invisible to returning visitors for up to
 * a year:
 * - /assets/grammars/<lang>.wasm — vendored tree-sitter grammars copied by
 *   viteStaticCopy and fetched at runtime by that literal URL
 *   (packages/build-utils getTreeSitterGrammarCopyTargets)
 * - /assets/pglite.wasm — the un-hashed viteStaticCopy of the PGlite wasm
 *
 * The override rules rely on Vercel applying header rules in order with the
 * later matching rule winning for the same header key — verified empirically
 * against the PR preview deployment.
 *
 * index.html is un-hashed and keeps Vercel's default revalidation (no rule).
 */
describe('vercel.json production headers', () => {
  it('ships the exact reviewed production CSP on every route', () => {
    const config = readVercelConfig();
    const appShellRule = config.headers?.find((rule) => rule.source === APP_SHELL_SOURCE);

    expect(appShellRule).toBeDefined();
    expect(headerValueOf(appShellRule as VercelHeaderRule, 'Content-Security-Policy')).toBe(
      getCSP('production')
    );
  });

  it('serves the Canvas shell with the sandbox CSP, ordered to win over the app-wide rule (BST-1173)', () => {
    const config = readVercelConfig();
    const sources = (config.headers ?? []).map((rule) => rule.source);
    const appShellIndex = sources.indexOf(APP_SHELL_SOURCE);
    const canvasIndex = sources.indexOf('/canvas-frame.html');

    expect(canvasIndex).toBeGreaterThanOrEqual(0);
    // The app-shell rule's negative lookahead makes the two rules DISJOINT —
    // the canvas path must match exactly one rule, so no reliance on Vercel's
    // duplicate-header-key behavior. Ordering pinned anyway for readability.
    expect(APP_SHELL_SOURCE).toContain('canvas-frame');
    expect(canvasIndex).toBeGreaterThan(appShellIndex);

    const canvasRule = (config.headers ?? [])[canvasIndex] as VercelHeaderRule;
    expect(headerValueOf(canvasRule, 'Content-Security-Policy')).toBe(
      getCanvasSandboxContentSecurityPolicy()
    );
    expect(headerValueOf(canvasRule, 'Content-Security-Policy')).not.toContain('frame-ancestors');
    expect(headerValueOf(canvasRule, 'X-Frame-Options')).toBeUndefined();
    // The dev server is cross-origin isolated; keep prod headers ready for the
    // same posture so enabling COEP app-wide can never orphan the canvas.
    expect(headerValueOf(canvasRule, 'Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(headerValueOf(canvasRule, 'Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(cacheControlOf(canvasRule)).toBe(REVALIDATE);
  });

  it('serves hashed /assets/* immutable for a year', () => {
    const config = readVercelConfig();
    const assetsRule = config.headers?.find((rule) => rule.source === '/assets/(.*)');

    expect(assetsRule).toBeDefined();
    expect(cacheControlOf(assetsRule as VercelHeaderRule)).toBe(IMMUTABLE);
  });

  it('keeps stable-named wasm (grammars, pglite) revalidating, ordered after the blanket rule', () => {
    const config = readVercelConfig();
    const sources = (config.headers ?? []).map((rule) => rule.source);
    const blanketIndex = sources.indexOf('/assets/(.*)');

    for (const stableSource of ['/assets/grammars/(.*)', '/assets/pglite.wasm']) {
      const index = sources.indexOf(stableSource);
      expect(index, `${stableSource} rule must exist`).toBeGreaterThanOrEqual(0);
      // Later matching rule wins for the same header key, so the override
      // must come AFTER the blanket immutable rule.
      expect(index, `${stableSource} must come after the blanket rule`).toBeGreaterThan(
        blanketIndex
      );
      const rule = (config.headers ?? [])[index] as VercelHeaderRule;
      expect(cacheControlOf(rule)).toBe(REVALIDATE);
    }
  });

  it("lets / and /index.html fall through to Vercel's default revalidation (BST-1850)", () => {
    // A failed lazy chunk is recovered by a reload, and the reload must fetch the NEW
    // index.html or it re-requests the old build's chunk names and fails again. Vercel's
    // documented default for a file with no rule is `public, max-age=0, must-revalidate`;
    // any cache header on a rule that matches the shell replaces it. Vercel's CDN reads
    // the CDN-Cache-Control pair ahead of Cache-Control, so all three count.
    const config = readVercelConfig();
    const matchesShell = (source: string): boolean =>
      ['/', '/index.html'].some((route) => new RegExp(`^${source}$`).test(route));

    // Prove the matcher can see the shell at all: the app-wide rule must match both paths.
    expect(matchesShell(APP_SHELL_SOURCE)).toBe(true);

    for (const rule of config.headers ?? []) {
      const cacheHeaders = rule.headers.filter((header) =>
        CACHE_HEADER_KEYS.includes(header.key.toLowerCase())
      );
      if (cacheHeaders.length === 0) {
        continue;
      }
      // A rule that sets a cache header must be a reviewed one that cannot match the shell.
      expect(
        REVIEWED_CACHE_SOURCES,
        `${rule.source} sets ${cacheHeaders.map((header) => header.key).join(', ')}; review that it cannot match / or /index.html before adding it here`
      ).toContain(rule.source);
      expect(matchesShell(rule.source), `${rule.source} matches the app shell`).toBe(false);
    }
  });
});

describe('Vercel preview assistant functions', () => {
  it('ships root api entrypoints for every hosted assistant route', () => {
    const webRoot = path.resolve(__dirname, '../..');

    for (const entrypoint of ['api/assistant.ts', 'api/assistant/status.ts']) {
      expect(existsSync(path.join(webRoot, entrypoint)), entrypoint).toBe(true);
    }
    // The legacy chat route owns a process-local rate limiter, which cannot be
    // enforced across Vercel instances. Keep it dev-only until it is replaced
    // by distributed state instead of deploying a misleading security control.
    expect(existsSync(path.join(webRoot, 'api/chat.ts'))).toBe(false);
  });

  it('gives streaming assistant functions an explicit duration budget', () => {
    const config = readVercelConfig();

    expect(config.functions?.['api/**/*.ts']?.maxDuration).toBe(300);
  });

  it('declares client-cancellation support for streaming assistant functions', () => {
    const config = readVercelConfig();

    expect(config.functions?.['api/**/*.ts']?.supportsCancellation).toBe(true);
  });

  it('keeps function entrypoints in the required Web type-check gate', () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
    ) as WebPackageJson;

    expect(packageJson.scripts?.['type-check:api']).toBe(
      'tsc --noEmit --project api/tsconfig.json'
    );
    expect(packageJson.scripts?.['type-check']).toContain('pnpm run type-check:api');
  });

  it('compiles function entrypoints as executable CommonJS instead of renderer declarations', () => {
    const functionTsconfig = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../api/tsconfig.json'), 'utf8')
    ) as VercelFunctionTsconfig;

    // Vercel strips a direct emitDeclarationOnly override before resolving
    // inherited options. Extending the renderer config would therefore emit
    // declaration syntax as .js and produce functions that fail at runtime.
    expect(functionTsconfig.extends).toBeUndefined();
    expect(functionTsconfig.compilerOptions?.emitDeclarationOnly).not.toBe(true);
    expect(functionTsconfig.compilerOptions?.module).toBe('Node16');
    expect(functionTsconfig.compilerOptions?.moduleResolution).toBe('Node16');
    expect(functionTsconfig.compilerOptions?.verbatimModuleSyntax).toBe(false);
  });
});
