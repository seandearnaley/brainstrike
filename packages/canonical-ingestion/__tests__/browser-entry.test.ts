import { resolve } from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { build, type Plugin } from 'esbuild';
import { expect, it } from 'vitest';

/** Workspace packages resolve to their sources, as the test lanes do. */
function workspaceSources(): Plugin {
  const aliases = workspaceSrcAliases(resolve(import.meta.dirname, '../..'));
  return {
    name: 'workspace-sources',
    setup(builder) {
      builder.onResolve({ filter: /^@brainstrike\// }, (args) => {
        const target = resolveThroughAliases(args.path, aliases);
        return target ? { path: target } : undefined;
      });
    },
  };
}

/**
 * The web app's bundler serves these as it does today: a module that reaches
 * Node only through a runtime-guarded dynamic import (the tree-sitter grammar
 * loader, web-tree-sitter's own Node branch), and tiktoken's wasm URL.
 */
function browserBundlerConventions(): Plugin {
  return {
    name: 'browser-bundler-conventions',
    setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, (args) => ({ external: true, path: args.path }));
      builder.onResolve({ filter: /^(node:)?[a-z_/]+$/ }, (args) =>
        args.kind === 'dynamic-import' ? { external: true, path: args.path } : undefined
      );
    },
  };
}

/**
 * The browser's index worker (BST-1940) runs the ingestion host. A browser
 * bundle cannot resolve a static Node import, so esbuild fails this build if
 * one becomes reachable from the browser entry.
 */
it('bundles the browser entry and its chunker for the browser, with no static Node import and no native parser', async () => {
  const result = await build({
    absWorkingDir: resolve(import.meta.dirname, '../../..'),
    bundle: true,
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    platform: 'browser',
    plugins: [browserBundlerConventions(), workspaceSources()],
    // What the index worker composes: the host, and the chunker it is given.
    stdin: {
      contents: [
        "export * from '@brainstrike/canonical-ingestion/browser';",
        "export { createBrowserChunker } from '@brainstrike/chunking-worker/canonical';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: resolve(import.meta.dirname, '../src'),
    },
    write: false,
  });
  const inputs = Object.keys(result.metafile.inputs);
  for (const composed of [
    'packages/canonical-ingestion/src/host.ts',
    'packages/canonical-ingestion/src/scoped-publication.ts',
    'packages/chunking-worker/src/canonical.ts',
    'packages/chunking-worker/src/parsers/babel-adapter.ts',
    'packages/chunking-worker/src/parsers/tree-sitter-adapter.ts',
    'packages/indexer/src/scope-authority.ts',
  ]) {
    expect(inputs).toContain(composed);
  }
  for (const nodeOnly of [
    'oxc-parser',
    'better-sqlite3',
    'chunking-worker/src/node/',
    'canonical-ingestion/src/workspace-source',
  ]) {
    expect(inputs.filter((input) => input.includes(nodeOnly))).toEqual([]);
  }
});
