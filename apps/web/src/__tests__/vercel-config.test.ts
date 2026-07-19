import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

const REVALIDATE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function cacheControlOf(rule: VercelHeaderRule): string | undefined {
  return rule.headers.find((header) => header.key.toLowerCase() === 'cache-control')?.value;
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

  it('never marks anything outside /assets/ immutable (index.html must revalidate)', () => {
    const config = readVercelConfig();
    for (const rule of config.headers ?? []) {
      const cacheControl = cacheControlOf(rule);
      if (cacheControl?.includes('immutable')) {
        expect(rule.source.startsWith('/assets/')).toBe(true);
      }
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
