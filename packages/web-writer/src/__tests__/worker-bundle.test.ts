import { resolve } from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

/**
 * The web app will bundle this worker as it stands: the state writer, the
 * indexer's browser entry and the host producer together. A browser bundle
 * cannot resolve a static Node import, so esbuild fails this build if one
 * becomes reachable. Workspace packages resolve to their sources.
 */
it('bundles the composed writer worker for the browser, with no Node module and no native SQLite', async () => {
  const aliases = workspaceSrcAliases(resolve(import.meta.dirname, '../../..'));
  const result = await build({
    bundle: true,
    // The file index's worker is a module the writer starts by URL, so it is an entry of its own.
    entryPoints: [
      resolve(import.meta.dirname, '../web-writer-worker.ts'),
      resolve(import.meta.dirname, '../file-index-worker.ts'),
    ],
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    outdir: 'bundle',
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
  for (const composed of [
    'web-state-store/src/web-state-writer.ts',
    'indexer/src/store.ts',
    'agent-host/src/host-state-producer.ts',
    'state-store/src/state-deletion.ts',
    'state-store/src/deletion-domain.mjs',
    'src/file-index-worker.ts',
    'indexer/src/scoped-operations.ts',
  ]) {
    expect(inputs.some((input) => input.includes(composed))).toBe(true);
  }
  for (const nodeOnly of [
    'better-sqlite3',
    'sqlite-native',
    'state-store/src/state-store.ts',
    'run-snapshot-blobs',
  ]) {
    expect(inputs.filter((input) => input.includes(nodeOnly))).toEqual([]);
  }
});
