// @vitest-environment node
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';
import { canonicalIndexPayload } from '@brainstrike/file-import/canonical-index-publication';
import { createIndexerConnection } from '@brainstrike/indexer/transport';
import { SqliteQueryClient, spawnQueryProcess } from '@brainstrike/sqlite-query';
import { expect, it } from 'vitest';
import { nativeGrepIndex } from '../../agent-host-platform/native-grep-index';
import { runGrepSearchWith } from '../../assistant-server/grep-search-core';
import { createNativeScopedSearchCapability } from '../../native-scoped-search';

/**
 * BST-1989: a markdown hit reports the line it is on. The fixture is a real note
 * with front matter, headings followed by blank lines, two blank lines in a row,
 * lists, a code fence and a quote. It goes through the production chunker and
 * the real IndexerPort; the index-only pass and the live pass must agree on
 * every line, so the merge reports each hit once.
 */
const relativePath = 'docs/notes.md';
const needle = 'mdneedle';
const binding = {
  embeddingSetId: 'selected',
  fileId: 'markdown-notes',
  profile: null,
  relativePath,
  rootId: 'root',
  sourcePath: null,
};
const collection = { embeddingSetId: 'selected', kind: 'collection' } as const;
const workspace = { kind: 'workspace', rootId: 'root' } as const;

function needleLines(source: string): number[] {
  return source.split('\n').flatMap((line, index) => (line.includes(needle) ? [index + 1] : []));
}

it('reports each markdown hit on its source line, once, through the real index and live passes', async () => {
  const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  const nodeExecutable = process.env['INDEXER_TEST_EXEC_PATH'];
  if (!(executable && nodeExecutable)) {
    throw new Error('Explicit qualified query and indexer executables are required.');
  }
  const source = await readFile(
    fileURLToPath(new URL('../fixtures/markdown-grep-notes.md', import.meta.url)),
    'utf8'
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'native-markdown-grep-'));
  const root = path.join(directory, 'workspace');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, relativePath), source);
  const dbPath = path.join(directory, 'index.sqlite');

  // The production chunk request: auto strategy, the workspace-relative path.
  const result = await createNodeChunker({ parser: 'oxc' })(source, {
    fileName: 'notes.md',
    filePath: relativePath,
    strategy: 'auto',
  });
  const payload = canonicalIndexPayload({
    kind: 'worker-result',
    result: { ...result, fileRecordId: binding.fileId, id: 'markdown-notes', type: 'result' },
    source: {
      content: source,
      fileName: 'notes.md',
      filePath: relativePath,
      fileRecordId: binding.fileId,
    },
  });
  expect(payload.providedChunks.length).toBeGreaterThan(0);
  // Each chunk's text is its own source span, byte for byte. Soft, so one run
  // reports the span and both line disagreements together.
  expect
    .soft(payload.providedChunks.map((chunk) => source.slice(chunk.startOffset, chunk.endOffset)))
    .toEqual(payload.providedChunks.map((chunk) => chunk.content));

  const child = fork(
    fileURLToPath(
      new URL('../../../../../packages/indexer/dist/process-entry.js', import.meta.url)
    ),
    [],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      execArgv: [],
      execPath: nodeExecutable,
      serialization: 'json',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
  );
  const connection = createIndexerConnection(
    {
      dbPath,
      embedding: { indexMode: 'text-only' },
      fileBindings: [binding],
      rootIds: ['root'],
      scopes: [collection, workspace],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 },
    {
      kill: () => child.kill(),
      onError: (listener) => {
        child.on('error', listener);
        return () => {
          child.off('error', listener);
        };
      },
      onExit: (listener) => {
        child.on('exit', listener);
        return () => {
          child.off('exit', listener);
        };
      },
      onMessage: (listener) => {
        child.on('message', listener);
        return () => {
          child.off('message', listener);
        };
      },
      send: (message) => {
        child.send(message);
      },
    }
  );
  try {
    const port = await connection.ready;
    const { profile: _profile, ...identity } = binding;
    const plan = await port.prepareScopedFile({
      snapshot: { ...identity, content: payload.content, providedChunks: payload.providedChunks },
    });
    await port.commitScopedTextFile({
      plan,
      ...(payload.syntax ? { syntax: payload.syntax } : {}),
    });
    const capability = createNativeScopedSearchCapability({
      openQuery: () =>
        SqliteQueryClient.open({
          databasePath: dbPath,
          deadlineMs: 1000,
          spawn: () =>
            spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
          startupDeadlineMs: 5000,
        }),
      rebuild: async () => {
        throw new Error('Unexpected rebuild');
      },
      withRead: (work) =>
        work({
          getAuthority: async () => ({
            bindings: [binding],
            collectionId: 'selected',
            generation: 1,
            profile: null,
            queryPlan: undefined,
            readiness: [
              { generation: 1, mutationRevision: 0, scanComplete: true, scope: collection },
              { generation: 1, mutationRevision: 0, scanComplete: true, scope: workspace },
            ],
            rootIds: ['root'],
          }),
          port,
        }),
    });
    const expected = needleLines(source);
    expect(expected.length).toBeGreaterThanOrEqual(7);

    // The index-only pass alone.
    const indexed = await nativeGrepIndex(capability)({
      contextLines: 0,
      pattern: needle,
      rootId: 'root',
    });
    expect.soft(indexed.matches.map((match) => match.line)).toEqual(expected);
    expect
      .soft(indexed.matches.map((match) => match.lineText))
      .toEqual(expected.map((line) => source.split('\n')[line - 1]));

    // The tool's index + live merge: every hit is found by both, once.
    const merged = await runGrepSearchWith(
      { outputMode: 'content', pattern: needle },
      { workspaceRoots: [{ displayName: 'workspace', path: root, rootId: 'root' }] },
      nativeGrepIndex(capability)
    );
    if (merged.outputMode !== 'content') {
      throw new Error('Expected a content-mode grep result.');
    }
    expect(merged.liveEngine).not.toBe('skipped');
    expect(
      merged.matches.map((match) => ({ line: match.line, path: match.path, source: match.source }))
    ).toEqual(expected.map((line) => ({ line, path: relativePath, source: 'both' })));
    expect(merged.totalMatches).toBe(expected.length);
  } finally {
    await connection.close();
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
