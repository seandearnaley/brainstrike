import { readFileSync } from 'node:fs';
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
      // As the web app's bundler serves them today: a module reaching Node only through a runtime-guarded
      // dynamic import (the tree-sitter grammar loader, web-tree-sitter's own Node branch), workerpool's
      // browser build, whose Node branches `require` Node's modules behind its platform check, and
      // tiktoken's wasm URL.
      {
        name: 'browser-bundler-conventions',
        setup(builder) {
          builder.onResolve({ filter: /\?url$/ }, (args) => ({ external: true, path: args.path }));
          builder.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) =>
            args.kind === 'dynamic-import' ||
            (args.kind === 'require-call' && /[\\/]workerpool[\\/]dist[\\/]/u.test(args.importer))
              ? { external: true, path: args.path }
              : undefined
          );
        },
      },
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
    'src/file-ingestion.ts',
    'canonical-ingestion/src/workspace-runtime.ts',
    'chunking-worker/src/canonical.ts',
    // VECTOR's profile, inference and embedder.
    'canonical-ingestion/src/canonical-profile.ts',
    'src/file-embeddings.ts',
    'embeddings/src/bge-m3-service.ts',
    'queue/src/browser.ts',
  ]) {
    expect(inputs.some((input) => input.includes(composed))).toBe(true);
  }
  // A browser worker has no Node globals: an unguarded `Buffer.` or `process.` throws at runtime, where
  // the build cannot see it. `globalThis.process?.…` and a line that checks `typeof` first are guarded.
  const unguarded: string[] = [];
  const workspaceSources = inputs.filter(
    (path) => !path.includes('node_modules') && (path.startsWith('../') || path.startsWith('src/'))
  );
  for (const input of workspaceSources) {
    readFileSync(resolve(import.meta.dirname, '../..', input), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) {
          return;
        }
        if (
          /(?<![\w$.?'"`])(?:Buffer|process)\s*\./.test(code) &&
          !/typeof (?:Buffer|process)\b/.test(code)
        ) {
          unguarded.push(`${input}:${index + 1}: ${code}`);
        }
      });
  }
  expect(unguarded).toEqual([]);
  for (const nodeOnly of [
    'better-sqlite3',
    'sqlite-native',
    'state-store/src/state-store.ts',
    'run-snapshot-blobs',
  ]) {
    expect(inputs.filter((input) => input.includes(nodeOnly))).toEqual([]);
  }
});
