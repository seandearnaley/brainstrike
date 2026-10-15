import { resolve } from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

/**
 * The browser writer (BST-1940) bundles the derived index from
 * `src/browser.ts`. A browser bundle cannot resolve a static Node import, so
 * esbuild fails this build if one becomes reachable. Workspace packages
 * resolve to their sources, as the test lanes do.
 */
it('bundles the browser entry for the browser, with no Node module and no native SQLite', async () => {
  const aliases = workspaceSrcAliases(resolve(import.meta.dirname, '../..'));
  const result = await build({
    bundle: true,
    entryPoints: [resolve(import.meta.dirname, '../src/browser.ts')],
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'browser',
    plugins: [
      {
        name: 'workspace-sources',
        setup(builder) {
          builder.onResolve({ filter: /^@brainstrike\// }, (args) => {
            const target = resolveThroughAliases(args.path, aliases);
            return target ? { path: target } : undefined;
          });
        },
      },
    ],
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs.some((input) => input.includes('src/store.ts'))).toBe(true);
  for (const native of ['better-sqlite3', 'sqlite-native', 'state-store/src/state-store.ts']) {
    expect(inputs.filter((input) => input.includes(native))).toEqual([]);
  }
});
