import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface VercelHeaderRule {
  readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly source: string;
}

interface VercelConfig {
  readonly headers?: readonly VercelHeaderRule[];
}

function readVercelConfig(): VercelConfig {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8')
  ) as VercelConfig;
}

/**
 * Production cache contract: everything under /assets/ is content-hashed by
 * the build (JS chunks, CSS, wasm, grammars), so it must be served immutable.
 * Without this rule Vercel serves `max-age=0, must-revalidate` (verified
 * against the live deployment) and every repeat visit revalidates every
 * chunk — hundreds of conditional requests since the bundle resplit.
 *
 * index.html is deliberately NOT covered: it is the un-hashed entry that must
 * revalidate so deploys roll out.
 */
describe('vercel.json production headers', () => {
  it('serves hashed /assets/* immutable for a year', () => {
    const config = readVercelConfig();
    const assetsRule = config.headers?.find((rule) => rule.source === '/assets/(.*)');

    expect(assetsRule).toBeDefined();
    expect(assetsRule?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'public, max-age=31536000, immutable',
    });
  });

  it('does not cache the un-hashed HTML entry', () => {
    const config = readVercelConfig();
    const htmlRules = config.headers?.filter(
      (rule) => rule.source === '/' || rule.source === '/index.html'
    );
    for (const rule of htmlRules ?? []) {
      for (const header of rule.headers) {
        if (header.key.toLowerCase() === 'cache-control') {
          expect(header.value).not.toContain('immutable');
        }
      }
    }
  });
});
