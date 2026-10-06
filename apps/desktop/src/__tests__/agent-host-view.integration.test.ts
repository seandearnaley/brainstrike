// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type AgentHost, startAgentHost } from '@brainstrike/agent-host';
import { attachAgentHost, type HostClient } from '@brainstrike/agent-host/client';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { type IndexerPort, openIndexer } from '@brainstrike/indexer';
import { RootLock, StateStore } from '@brainstrike/state-store';
import { build } from 'esbuild';
import { _electron, type ElectronApplication } from 'playwright';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { scriptedToolSequence } from '../../../../packages/agent-host/__tests__/fixtures/scripted-model';

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../../..');
const desktop = join(repository, 'apps/desktop');
let application: ElectronApplication | undefined;
let host: AgentHost | undefined;
let client: HostClient | undefined;
let indexer: IndexerPort | undefined;
let root: string | undefined;
let buildDirectory: string | undefined;
afterEach(async () => {
  await application?.close();
  application = undefined;
  await client?.close();
  client = undefined;
  await host?.close();
  host = undefined;
  await indexer?.close();
  indexer = undefined;
  if (root) {
    await rm(root, { force: true, recursive: true });
    root = undefined;
  }
  if (buildDirectory) {
    await rm(buildDirectory, { force: true, recursive: true });
    buildDirectory = undefined;
  }
});

test('CLI and Electron share an authenticated Node host, approved file action, real SQLite search and committed view', async () => {
  const started = performance.now();
  const checkpoint = (phase: string): void => {
    process.stderr.write(
      `${JSON.stringify({ elapsedMs: Math.round(performance.now() - started), phase })}\n`
    );
  };
  root = await mkdtemp(join(tmpdir(), 'brainstrike-m3-composed-'));
  buildDirectory = join(desktop, 'dist', `owned-host-view-${randomUUID()}`);
  await mkdir(buildDirectory, { recursive: true });
  const fixtures = join(desktop, 'src/__tests__/fixtures');
  const main = join(buildDirectory, 'main.cjs');
  const preload = join(buildDirectory, 'preload.cjs');
  const html = join(buildDirectory, 'index.html');
  await Promise.all([
    build({
      bundle: true,
      entryPoints: [join(fixtures, 'agent-host-view-electron.ts')],
      format: 'cjs',
      outfile: main,
      packages: 'external',
      platform: 'node',
    }),
    build({
      bundle: true,
      entryPoints: [join(fixtures, 'agent-host-view-preload.ts')],
      external: ['electron'],
      format: 'cjs',
      outfile: preload,
      platform: 'node',
    }),
    build({
      alias: { '@brainstrike/ui': join(repository, 'packages/ui/src/button.tsx') },
      bundle: true,
      entryPoints: [join(fixtures, 'agent-host-view-renderer.tsx')],
      format: 'iife',
      jsx: 'automatic',
      outfile: join(buildDirectory, 'renderer.js'),
      platform: 'browser',
    }),
  ]);
  await writeFile(
    html,
    '<!doctype html><html><body><div id="root"></div><script src="./renderer.js"></script></body></html>'
  );
  checkpoint('bundled');
  const ownedRoot = root;
  const path = join(root, 'permitted.txt');
  // The actual indexer process owns its WAL writer; no invented vectors are used.
  indexer = await openIndexer(
    {
      dbPath: join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: ['owned-root'],
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const nativeIndex = indexer;
  checkpoint('indexer-ready');
  const model = scriptedToolSequence([
    { input: { text: 'native SQLite assistant retrieval evidence' }, toolId: 'write_file' },
    { input: { query: 'retrieval' }, toolId: 'search_index' },
  ]);
  host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => model,
      tools: {
        search_index: {
          description: 'Search the actual native keyword index',
          execute: (input) =>
            nativeIndex.search({
              limit: 10,
              mode: 'bm25',
              rootIds: ['owned-root'],
              text: z.object({ query: z.string() }).parse(input).query,
            }),
          identity: 'owned-native-index-reader',
          inputSchema: z.object({ query: z.string() }),
          risk: 'read',
        },
        write_file: {
          description: 'Write and index the owned file',
          execute: async (input) => {
            const { text } = z.object({ text: z.string() }).parse(input);
            await writeFile(path, text);
            const plan = await nativeIndex.prepareFile({
              chunkLines: 1,
              content: await readFile(path, 'utf8'),
              fileId: 'owned-file',
              relativePath: 'permitted.txt',
              rootId: 'owned-root',
            });
            await nativeIndex.commitTextFile({ plan });
            return { path };
          },
          identity: 'owned-native-file-action',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    }
  );
  client = await attachAgentHost(host.record);
  checkpoint('host-authenticated');
  const cli = async (args: string[]): Promise<unknown> => {
    const result = await execute(process.execPath, [
      join(repository, 'packages/agent-host/dist/cli.js'),
      '--root',
      ownedRoot,
      ...args,
    ]);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  };
  const { threadId } = z.object({ threadId: z.string() }).parse(await cli(['thread', 'start']));
  checkpoint('cli-thread');
  const executablePath =
    process.env['BRAINSTRIKE_TEST_ELECTRON_EXEC_PATH'] ??
    join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  await access(executablePath);
  const electronEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) {
      electronEnvironment[key] = value;
    }
  }
  Object.assign(electronEnvironment, {
    BRAINSTRIKE_M3_OWNED_HTML: html,
    BRAINSTRIKE_M3_OWNED_PRELOAD: preload,
    BRAINSTRIKE_M3_OWNED_ROOT: root,
    BRAINSTRIKE_M3_OWNED_THREAD: threadId,
  });
  application = await _electron.launch({ args: [main], env: electronEnvironment, executablePath });
  checkpoint('electron-launched');
  const page = await application.firstWindow();
  page.on('console', (message) =>
    process.stderr.write(`renderer ${message.type()}: ${message.text()}\n`)
  );
  page.on('pageerror', (cause) => process.stderr.write(`renderer error: ${cause.message}\n`));
  checkpoint('electron-window');
  await expect.poll(() => page.getByRole('textbox', { name: 'Message' }).isEnabled()).toBe(true);
  const { runId } = z
    .object({ runId: z.string() })
    .parse(
      await cli([
        'run',
        'start',
        '--thread',
        threadId,
        '--model',
        'scripted',
        '--prompt',
        'Write the owned file and search its native index.',
      ])
    );
  await page.getByRole('button', { exact: true, name: 'Approve' }).waitFor();
  await expect(access(path)).rejects.toThrow();
  await page.getByRole('button', { exact: true, name: 'Approve' }).click();
  await expect.poll(() => page.getByLabel('Run status').textContent()).toBe('completed');
  expect(await page.getByRole('log', { name: 'Assistant output' }).textContent()).toBe(
    'Host run completed.'
  );
  expect(await page.getByLabel('Tool result').allTextContents()).toContainEqual(
    expect.stringContaining('owned-file')
  );
  expect(await readFile(path, 'utf8')).toBe('native SQLite assistant retrieval evidence');
  const rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
  expect(rows.filter((row) => row.event.type === 'interaction.requested')).toHaveLength(1);
  expect(rows.filter((row) => row.event.type === 'effect.finished')).toHaveLength(2);
  expect(rows.at(-1)?.event).toEqual({ outcome: 'completed', runId, type: 'run.finished' });
  expect(
    z
      .object({ rows: z.array(z.unknown()) })
      .parse(await cli(['thread', 'read', '--thread', threadId])).rows
  ).toEqual(rows);
  await application.close();
  application = await _electron.launch({ args: [main], env: electronEnvironment, executablePath });
  const reopened = await application.firstWindow();
  await expect.poll(() => reopened.getByLabel('Run status').textContent()).toBe('completed');
  expect(await reopened.getByRole('log', { name: 'Assistant output' }).textContent()).toBe(
    'Host run completed.'
  );
  expect(model.doStreamCalls).toHaveLength(3);
  const artifact = process.env['BRAINSTRIKE_M3_PROOF_DIRECTORY'];
  if (artifact) {
    await mkdir(artifact, { recursive: true });
    await reopened.screenshot({ path: join(artifact, 'cli-electron-native-search.png') });
    await writeFile(join(artifact, 'committed-log.json'), JSON.stringify(rows, null, 2));
    await writeFile(
      join(artifact, 'receipt.json'),
      JSON.stringify(
        {
          hostPid: host.record.pid,
          modelCalls: model.doStreamCalls.length,
          nativeIndexer: await nativeIndex.info(),
          replayedAfterWindowClose: true,
          rowCount: rows.length,
          runId,
          testPid: process.pid,
          threadId,
        },
        null,
        2
      )
    );
  }
  const electronPid = application.process().pid;
  const indexerPid = (await nativeIndex.info()).pid;
  await application.close();
  application = undefined;
  if (electronPid) {
    expect(() => process.kill(electronPid, 0)).toThrow();
  }
  await client.close();
  client = undefined;
  await host.close();
  host = undefined;
  await nativeIndex.close();
  indexer = undefined;
  expect(() => process.kill(indexerPid, 0)).toThrow();
  expect(RootLock.inspect(ownedRoot)?.owner.released).toBe(true);
  await expect(access(join(ownedRoot, 'host.json'))).rejects.toThrow();
  const reopenedStore = await StateStore.open(ownedRoot);
  try {
    const persisted = await reopenedStore.read(threadId);
    expect(persisted.map((row) => row.seq)).toEqual(rows.map((row) => row.seq));
    expect(persisted.at(-1)?.event.type).toBe('run.finished');
  } finally {
    await reopenedStore.close();
  }
  if (artifact) {
    await writeFile(
      join(artifact, 'cleanup.json'),
      JSON.stringify(
        {
          electronPid,
          hostRecordRemoved: true,
          indexerPid,
          processesJoined: true,
          reopenedStoreRows: rows.length,
          rootReleased: true,
        },
        null,
        2
      )
    );
  }
});
