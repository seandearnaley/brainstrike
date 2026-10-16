import { resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

/** What the browser writer runs from this package (docs/agents/state-store.md). */
const PORTABLE = [
  'catalog-domains.mjs',
  'deletion-domain.mjs',
  'large-text.ts',
  'run-log.mjs',
  'schema.mjs',
  'state-deletion.ts',
  'state-truth-reader.ts',
];

/**
 * A browser bundle cannot resolve a static Node import, so esbuild fails this
 * build if one becomes reachable from a module the browser writer shares.
 */
it('bundles the modules the browser writer shares for the browser, with no Node module', async () => {
  const src = resolve(import.meta.dirname, '../src');
  const result = await build({
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'browser',
    stdin: {
      contents: PORTABLE.map((file) => `export * from './${file}';`).join('\n'),
      loader: 'ts',
      resolveDir: src,
    },
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs);
  for (const file of PORTABLE) {
    expect(inputs.some((input) => input.endsWith(`src/${file}`))).toBe(true);
  }
  for (const nodeOnly of ['better-sqlite3', 'src/state-store.ts', 'src/writer-worker.mjs']) {
    expect(inputs.filter((input) => input.includes(nodeOnly))).toEqual([]);
  }
});
