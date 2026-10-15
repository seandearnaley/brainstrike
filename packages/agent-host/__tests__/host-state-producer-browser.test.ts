import { resolve } from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

/**
 * The browser state writer (BST-1940) runs this producer. A browser bundle
 * cannot resolve a static Node import, so esbuild fails this build if one
 * becomes reachable. Workspace packages resolve to their sources.
 */
it('bundles the host state producer for the browser, with no Node module', async () => {
  const aliases = workspaceSrcAliases(resolve(import.meta.dirname, '../..'));
  const result = await build({
    bundle: true,
    entryPoints: [resolve(import.meta.dirname, '../src/host-state-producer.ts')],
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
  expect(inputs.some((input) => input.includes('src/host-event-decoding.ts'))).toBe(true);
  for (const nodeOnly of [
    'state-store/src/state-store.ts',
    'better-sqlite3',
    'run-snapshot-blobs',
  ]) {
    expect(inputs.filter((input) => input.includes(nodeOnly))).toEqual([]);
  }
});
