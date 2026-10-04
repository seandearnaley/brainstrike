// @vitest-environment node
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  assertCoverageAuthorityBound,
  MAX_NATIVE_COVERAGE_AUTHORITY_BYTES,
} from '@brainstrike/indexer/coverage-reader';
import { createIndexerConnection } from '@brainstrike/indexer/transport';
import { openConnection } from '@brainstrike/sqlite-native';
import { type QueryProcess, SqliteQueryClient } from '@brainstrike/sqlite-query';
import { Schema } from 'effect';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';
import { isolateNativeCoverage } from '../native-coverage-reader';

const scope = { embeddingSetId: 'ordering', kind: 'collection' } as const;
const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const control = Schema.Struct({ kind: Schema.String });

it.each(['progress', 'cancel', 'shutdown', 'deadline', 'corruption'] as const)(
  'owns isolated coverage %s while preserving the real writer and cleanup',
  async (mode) => {
    const desktop = path.resolve(import.meta.dirname, '../..');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'coverage-rpc-ordering-'));
    const fixtureDirectory = await mkdtemp(path.join(desktop, '.indexer-proof-'));
    const releasePath = path.join(directory, 'released');
    const dbPath = path.join(directory, 'index.sqlite');
    const events: string[] = [];
    const completions: Promise<unknown>[] = [];
    let connection: ReturnType<typeof createIndexerConnection> | undefined;
    let inspector: ReturnType<typeof openConnection> | undefined;
    let child: ReturnType<typeof fork> | undefined;
    let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stopPhysicalRead = false;
    const readers: SqliteQueryClient[] = [];
    const readController = new AbortController();
    const readerExits: Promise<void>[] = [];
    try {
      await build({
        ...MAIN_PROCESS_BUILD_OPTIONS,
        entryPoints: {
          'canonical-proof': 'src/__tests__/fixtures/canonical-indexer-node-proof.ts',
          'ordering-proof': 'src/__tests__/fixtures/coverage-rpc-ordering-proof.ts',
        },
        logLevel: 'silent',
        outdir: fixtureDirectory,
      });
      child = fork(path.join(fixtureDirectory, 'canonical-proof.js'), [], {
        execArgv: [],
        execPath: process.execPath,
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const ownedChild = child;
      let stderr = '';
      ownedChild.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      exit = new Promise((resolve) => {
        ownedChild.once('exit', (code, signal) => resolve({ code, signal }));
      });
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const open = async (
        authority: Parameters<typeof SqliteQueryClient.openNativeCoverage>[0]['authority']
      ) => {
        const readChild = fork(path.join(fixtureDirectory, 'ordering-proof.js'), [], {
          env: { ...process.env, COVERAGE_ORDERING_RELEASE_PATH: releasePath },
          execArgv: [],
          execPath: process.execPath,
          serialization: 'advanced',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        readerExits.push(
          new Promise((resolve) =>
            readChild.once('exit', () => {
              events.push('reader-exit');
              resolve();
            })
          )
        );
        readChild.on('message', (message: unknown) => {
          if (Schema.is(control)(message) && message.kind.startsWith('ordering-')) {
            events.push(message.kind);
            if (message.kind === 'ordering-held') {
              enter();
            }
          }
        });
        const transport: QueryProcess = {
          kill: () => {
            if (!readChild.kill('SIGKILL')) {
              throw new Error('Coverage reader kill was refused.');
            }
          },
          onError: (listener) => {
            readChild.on('error', listener);
            return () => {
              readChild.off('error', listener);
            };
          },
          onExit: (listener) => {
            readChild.on('exit', listener);
            return () => {
              readChild.off('exit', listener);
            };
          },
          onMessage: (listener) => {
            const receive = (message: unknown): void => {
              if (Schema.is(control)(message) && message.kind.startsWith('ordering-')) {
                return;
              }
              listener(message);
            };
            readChild.on('message', receive);
            return () => {
              readChild.off('message', receive);
            };
          },
          pid: readChild.pid,
          postMessage: (message) => {
            readChild.send(message);
          },
        };
        const client = await SqliteQueryClient.openNativeCoverage({
          authority,
          deadlineMs: mode === 'deadline' ? 100 : 5000,
          spawn: () => transport,
          startupDeadlineMs: 5000,
        });
        readers.push(client);
        return {
          close: () => client.close(),
          nativeCoverage: (requests: Parameters<typeof client.nativeCoverage>[0]) =>
            client.nativeCoverage(requests, { signal: readController.signal }),
        };
      };
      const bindings = ['first', 'second'].map((fileId) => ({
        embeddingSetId: scope.embeddingSetId,
        fileId,
        profile,
        relativePath: null,
        rootId: null,
        sourcePath: `/imports/${fileId}.txt`,
      }));
      connection = createIndexerConnection(
        {
          dbPath,
          embedding: { indexMode: 'text-only' },
          fileBindings: bindings,
          rootIds: [],
          scopes: [scope],
        },
        { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 },
        {
          kill: () => ownedChild.kill(),
          onError: (listener) => {
            ownedChild.on('error', listener);
            return () => ownedChild.off('error', listener);
          },
          onExit: (listener) => {
            ownedChild.on('exit', listener);
            return () => ownedChild.off('exit', listener);
          },
          onMessage: (listener) => {
            const receive = (message: unknown): void => {
              if (Schema.is(control)(message) && message.kind.startsWith('ordering-')) {
                return;
              }
              listener(message);
            };
            ownedChild.on('message', receive);
            return () => ownedChild.off('message', receive);
          },
          send: (message) => {
            ownedChild.send(message);
          },
        }
      );
      const port = isolateNativeCoverage(await connection.ready, open);
      expect((await port.info()).writerThreadId).toBeGreaterThan(0);
      const embeddings = (chunkIds: readonly string[]) =>
        chunkIds.map((chunkId) => ({ chunkId, vector: new Array<number>(384).fill(1) }));
      for (const { profile: _profile, ...snapshot } of bindings) {
        const plan = await port.prepareScopedFile({
          profile,
          snapshot: { ...snapshot, chunkLines: 1, content: `${snapshot.fileId}\n` },
        });
        await port.commitScopedFile({
          embeddings: embeddings(plan.embeddingChunkIds),
          plan,
          profile,
        });
      }
      const second = bindings[1];
      if (!second) {
        throw new Error('Missing second fixture binding.');
      }
      const { profile: _profile, ...snapshot } = second;
      const plan = await port.prepareScopedFile({
        profile,
        snapshot: { ...snapshot, chunkLines: 1, content: 'durable second version\n' },
      });
      inspector = openConnection(dbPath, { readonly: true });
      const coverage = port.coverageBatch([{ profile, scope }]);
      completions.push(coverage);
      void coverage.catch((error: unknown) => error);
      const bounded = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error(`Ordering fixture hung: ${stderr}`)), 5000);
      });
      await Promise.race([held, bounded]);
      if (mode !== 'progress' && mode !== 'corruption') {
        if (mode === 'cancel') {
          readController.abort(new Error('Cancel held coverage'));
        }
        if (mode === 'shutdown') {
          await Promise.all(readers.map((reader) => reader.close()));
        }
        await expect(coverage).rejects.toMatchObject({
          name:
            mode === 'cancel'
              ? 'SqliteQueryCancelledError'
              : mode === 'deadline'
                ? 'SqliteQueryDeadlineError'
                : 'Error',
        });
        expect(events).toContain('reader-exit');
        expect(events).not.toContain('ordering-released');
        return;
      }
      const ack = port
        .commitScopedFile({ embeddings: embeddings(plan.embeddingChunkIds), plan, profile })
        .then(() => {
          events.push('writer-ack');
        });
      completions.push(ack);
      void ack.catch((error: unknown) => error);
      void coverage.catch((error: unknown) => error);
      const info = port.info().then(() => {
        events.push('info-response');
      });
      completions.push(info);
      void info.catch((error: unknown) => error);
      const physical = async (): Promise<void> => {
        if (!inspector) {
          throw new Error('Missing independent reader.');
        }
        const query = inspector.prepare<unknown[], { contentHash: string }>(
          'SELECT content_hash AS contentHash FROM file_records WHERE id=?'
        );
        while (query.get('second')?.contentHash !== plan.contentHash) {
          if (stopPhysicalRead) {
            throw new Error('Physical visibility read cancelled during cleanup.');
          }
          await nextTurn();
        }
        events.push('physical-commit');
      };
      const physicalRead = physical();
      completions.push(physicalRead);
      await Promise.race([Promise.all([physicalRead, ack, info]), bounded]);
      // Release only after independent visibility proves the worker progressed.
      events.push('parent-release');
      await writeFile(releasePath, 'release');
      await Promise.all(completions);
      const released = events.indexOf('parent-release');
      expect({
        acknowledgementBeforeRelease: events.indexOf('writer-ack') < released,
        infoBeforeRelease: events.indexOf('info-response') < released,
      }).toEqual({ acknowledgementBeforeRelease: true, infoBeforeRelease: true });
      if (mode === 'corruption') {
        const requests = [{ profile, scope }];
        const healthy = await port.coverageBatch(requests);
        expect(healthy[0]?.counts).toEqual({
          chunks: 2,
          indexedFiles: 2,
          missingVectors: 0,
          vectors: 2,
        });
        for (const change of [{ storeId: 'a'.repeat(64) }, { authorityEpoch: 'b'.repeat(64) }]) {
          const forged = isolateNativeCoverage(port, (authority) =>
            open({ ...authority, ...change })
          );
          await expect(forged.coverageBatch(requests)).rejects.toMatchObject({
            code: 'coverage-authority-changed',
          });
        }
        const forgedMembership = isolateNativeCoverage(port, (authority) =>
          open({
            ...authority,
            fileBindings: authority.fileBindings.map((file) => ({
              ...file,
              sourcePath: '/foreign/source.txt',
            })),
          })
        );
        await expect(forgedMembership.coverageBatch(requests)).rejects.toMatchObject({
          code: 'file-ownership-changed',
        });
        await expect(
          port.coverageBatch([{ profile: { ...profile, dtype: 'fp16' }, scope }])
        ).rejects.toMatchObject({ code: 'profile-not-authorized' });
        await expect(
          port.coverageBatch([
            { profile, scope: { embeddingSetId: 'foreign', kind: 'collection' } },
          ])
        ).rejects.toMatchObject({ code: 'scope-not-authorized' });
        const mutation = openConnection(dbPath, { fileMustExist: true });
        try {
          const row = mutation
            .prepare<
              unknown[],
              { pk: number; emb: Buffer; contentHash: string; profileHash: string }
            >(
              'SELECT pk,emb,content_hash AS contentHash,profile_hash AS profileHash FROM scoped_vectors ORDER BY pk LIMIT 1'
            )
            .get();
          if (!row) {
            throw new Error('Missing real vector for corruption controls.');
          }
          for (const corrupt of [Buffer.alloc(384 * 4), Buffer.from(row.emb)]) {
            if (corrupt.some((value) => value !== 0)) {
              corrupt.writeFloatLE(Number.NaN, 0);
            }
            mutation.prepare('UPDATE scoped_vectors SET emb=? WHERE pk=?').run(corrupt, row.pk);
            await expect(port.coverageBatch(requests)).rejects.toMatchObject({
              code: 'rebuild-required',
            });
            mutation.prepare('UPDATE scoped_vectors SET emb=? WHERE pk=?').run(row.emb, row.pk);
          }
          mutation
            .prepare('UPDATE scoped_vectors SET content_hash=? WHERE pk=?')
            .run('0'.repeat(64), row.pk);
          await expect(port.coverageBatch(requests)).rejects.toMatchObject({
            code: 'rebuild-required',
          });
          mutation
            .prepare('UPDATE scoped_vectors SET content_hash=? WHERE pk=?')
            .run(row.contentHash, row.pk);
          mutation.prepare('DELETE FROM scope_vec_384 WHERE id=?').run(row.pk);
          await expect(port.coverageBatch(requests)).rejects.toMatchObject({
            code: 'rebuild-required',
          });
          mutation
            .prepare(
              'INSERT INTO scope_vec_384(id,profile_hash,bin) VALUES(?,?,vec_quantize_binary(?))'
            )
            .run(BigInt(row.pk), row.profileHash, row.emb);
          mutation.prepare('UPDATE index_metadata SET schema_version=7 WHERE singleton=1').run();
          await expect(port.coverageBatch(requests)).rejects.toMatchObject({
            code: 'rebuild-required',
          });
          mutation.prepare('UPDATE index_metadata SET schema_version=8 WHERE singleton=1').run();
        } finally {
          mutation.close();
        }
        expect((await port.coverageBatch(requests))[0]?.vectorCoverageComplete).toBe(true);
      }
    } finally {
      stopPhysicalRead = true;
      if (watchdog) {
        clearTimeout(watchdog);
      }
      await writeFile(releasePath, 'release');
      await Promise.allSettled(completions);
      await Promise.all(readers.map((reader) => reader.close()));
      await Promise.all(readerExits);
      inspector?.close();
      if (connection) {
        await connection.close();
      } else {
        child?.kill();
      }
      if (exit) {
        const result = await exit;
        events.push(`exit:${result.code}:${result.signal}`);
        expect(result).toEqual({ code: 0, signal: null });
      }
      console.info('Coverage RPC ordering and owned cleanup:', JSON.stringify(events));
      await rm(fixtureDirectory, { force: true, recursive: true });
      await rm(directory, { force: true, recursive: true });
    }
  },
  15_000
);

it('bounds the trusted authority envelope for the retained 5000-file corpus shape without widening SQL budgets', () => {
  const rootPath =
    '/var/folders/88/jjwxcv3n76x4p7t1xz693qc00000gn/T/brainstrike-index-build-corpus-YwOEL5';
  const rootId = 'm2-performance-root';
  const fileBindings = Array.from({ length: 5000 }, (_, index) => {
    const relativePath = `packages/pkg-${String(index % 24).padStart(2, '0')}/src/area-${index % 5}/module-${String(index).padStart(5, '0')}.ts`;
    return {
      embeddingSetId: scope.embeddingSetId,
      fileId: String(index).padStart(64, '0'),
      profile: { ...profile },
      relativePath,
      rootId,
      sourcePath: `${rootPath}/${relativePath}`,
    };
  });
  const envelope = {
    authority: {
      authorityEpoch: 'b'.repeat(64),
      authorityRevision: 100,
      dbPath: `${rootPath}/user-data/profiles/test/index.sqlite`,
      fileBindings,
      rootIds: [rootId],
      scopes: [scope, { kind: 'workspace', rootId }],
      storeId: 'a'.repeat(64),
    },
    id: Number.MAX_SAFE_INTEGER,
    kind: 'open-native-coverage',
  };
  const bytes = assertCoverageAuthorityBound(envelope);
  console.info(
    'Native coverage 5000-file authority envelope:',
    bytes,
    'bytes; bound:',
    MAX_NATIVE_COVERAGE_AUTHORITY_BYTES
  );
  expect(bytes).toBeLessThan(MAX_NATIVE_COVERAGE_AUTHORITY_BYTES);
  expect(() =>
    assertCoverageAuthorityBound({
      ...envelope,
      oversized: 'x'.repeat(MAX_NATIVE_COVERAGE_AUTHORITY_BYTES),
    })
  ).toThrow('32 MiB message budget');
});
