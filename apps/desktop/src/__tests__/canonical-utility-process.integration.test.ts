// @vitest-environment node
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalPublicationPort,
  CanonicalVectorPublicationPort,
} from '@brainstrike/canonical-ingestion';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { ScopedFilePlan } from '@brainstrike/indexer';
import { createIndexerConnection } from '@brainstrike/indexer/transport';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';
import { CanonicalUtilityParent } from '../canonical-utility-parent';
import { isCanonicalFrame } from '../canonical-utility-protocol';
import type { EmbeddingHostDocumentEmbeddingsPayload } from '../embedding-host-shared';
import { generateHostedEmbeddings } from '../hosted-embeddings';
import { createNativeCanonicalCatalog } from '../native-canonical-catalog';
import {
  NativeCanonicalInference,
  NativeCanonicalProfileResolver,
  resolveNativeCanonicalProfile,
} from '../native-canonical-profile';

const desktop = path.resolve(import.meta.dirname, '../..');
const scope = { embeddingSetId: 'actual-set', kind: 'collection' as const };
const baseIdentity = {
  embeddingSetId: 'actual-set',
  fileId: 'actual-file',
  fileName: 'source.ts',
  relativePath: null,
  rootId: null,
  sourcePath: null,
};
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');

/**
 * Real-shaped source per file kind (BST-1983). The broken ones carry a syntax
 * error their parser recovers from, so they index rather than block the scan.
 */
function sourceText(fileName: string, version: string): string {
  switch (fileName) {
    case 'merge_sort.py':
      return `@cache\ndef merge_sort(xs):\n    """canonical transport ${version}"""\n    if len(xs) <= 1:\n        return xs\n    middle = len(xs) // 2\n    return merge(merge_sort(xs[:middle]), merge_sort(xs[middle:]))\n`;
    case 'broken.py':
      return `def merge_sort(xs:\n    return "canonical transport ${version}"\n`;
    case 'broken.ts':
      return `export function native( {\n  return "canonical transport ${version}";\n}\n`;
    default:
      return `export function native(): string {\n  return "canonical transport ${version}";\n}\n`;
  }
}

/** Where a recognized declaration's chunk must begin: with its modifiers and decorators. */
const DECLARATION_START: Readonly<Record<string, string>> = {
  'merge_sort.py': '@cache\ndef merge_sort(xs):',
  'source.ts': 'export function native(): string {',
};
function nativeIdentity(file: CanonicalFileIdentity) {
  return {
    embeddingSetId: file.embeddingSetId,
    fileId: file.fileId,
    relativePath: file.relativePath,
    rootId: file.rootId,
    sourcePath: file.sourcePath,
  };
}

it.each([
  { fileName: 'source.ts', mode: 'TEXT', provider: 'local' },
  { fileName: 'source.ts', mode: 'VECTOR', provider: 'local' },
  { fileName: 'source.txt', mode: 'VECTOR', provider: 'local' },
  { fileName: 'source.ts', mode: 'VECTOR', provider: 'cohere' },
  { fileName: 'merge_sort.py', mode: 'TEXT', provider: 'local' },
  { fileName: 'merge_sort.py', mode: 'VECTOR', provider: 'local' },
  { fileName: 'broken.py', mode: 'TEXT', provider: 'local' },
  { fileName: 'broken.ts', mode: 'TEXT', provider: 'local' },
] as const)(
  'publishes $provider $mode $fileName real PG retained source through the built attachment into one native writer and joins process exit',
  async ({ mode, fileName, provider }) => {
    const identity = { ...baseIdentity, fileName };
    const directory = await mkdtemp(path.join(os.tmpdir(), 'canonical-native-index-'));
    const fixtureDirectory = await mkdtemp(path.join(desktop, '.indexer-proof-'));
    const db = await wasmLoader.createPGlite('memory://canonical-utility-process');
    let original = sourceText(fileName, 'firstversion');
    await migrate(db);
    const metadata = {
      dimensions: mode === 'VECTOR' ? (provider === 'cohere' ? 1024 : 384) : 1536,
      distance: 'cosine' as const,
      id: scope.embeddingSetId,
      modelId:
        mode === 'VECTOR'
          ? provider === 'cohere'
            ? 'embed-english-v3.0'
            : 'Xenova/bge-small-en-v1.5'
          : 'saved-model',
      modelKey:
        mode === 'VECTOR'
          ? provider === 'cohere'
            ? 'cohere::embed-english-v3.0'
            : 'local::Xenova/bge-small-en-v1.5'
          : 'openai::saved-model',
    };
    const selection = {
      device: 'wasm' as const,
      dimensions: 384,
      dtype: 'q8' as const,
      modelId: 'Xenova/bge-small-en-v1.5',
    };
    const profile =
      mode === 'VECTOR' ? resolveNativeCanonicalProfile(metadata, selection).profile : null;
    await db.query(
      'INSERT INTO embedding_sets(id,model_key,model_id,dimensions,distance) VALUES ($1,$2,$3,$4,$5)',
      [metadata.id, metadata.modelKey, metadata.modelId, metadata.dimensions, metadata.distance]
    );
    const resolver = new NativeCanonicalProfileResolver({
      query: async (sql, params) => ({ rows: (await db.query(sql, params)).rows }),
      readLocalSelection: async () => selection,
      resolveEmbeddingSetId: async (requested) => {
        expect(requested).toEqual(scope);
        return scope.embeddingSetId;
      },
    });
    let physicalHold:
      | {
          readonly entered: () => void;
          readonly aborted: () => void;
          readonly released: Promise<void>;
        }
      | undefined;
    const documentEmbeddings = vi.fn(
      async (
        payload: EmbeddingHostDocumentEmbeddingsPayload,
        options?: { signal?: AbortSignal }
      ) => {
        if (!options?.signal) {
          throw new Error('Missing physically owned inference signal.');
        }
        if (physicalHold) {
          options.signal.addEventListener('abort', physicalHold.aborted, { once: true });
          physicalHold.entered();
          await physicalHold.released;
        }
        await Promise.resolve();
        options.signal.throwIfAborted();
        return payload.texts.map(() => new Array<number>(payload.dimensions).fill(1));
      }
    );
    const hostedFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error('Missing physically owned hosted signal.');
      }
      const body = JSON.parse(String(init?.body)) as { texts: string[]; input_type: string };
      expect(body.input_type).toBe(
        body.texts[0] === 'find canonical source' ? 'search_query' : 'search_document'
      );
      if (physicalHold) {
        signal.addEventListener('abort', physicalHold.aborted, { once: true });
        physicalHold.entered();
        await physicalHold.released;
      }
      signal.throwIfAborted();
      return new Response(
        JSON.stringify({
          embeddings: {
            float: body.texts.map(() => new Array<number>(metadata.dimensions).fill(1)),
          },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      );
    });
    if (provider === 'cohere') {
      vi.stubEnv('COHERE_API_KEY', 'recorded-test-key');
      vi.stubGlobal('fetch', hostedFetch);
    }
    const ownedInference = new NativeCanonicalInference({
      resolver,
      scope,
      transport: { documentEmbeddings },
    });
    const inference = {
      cancel: vi.fn((requestId: string) => ownedInference.cancel(requestId)),
      generate: vi.fn(ownedInference.generate),
      join: vi.fn((requestId: string) => ownedInference.join(requestId)),
    };
    await db.query(
      `INSERT INTO file_records(id,name,path,embedding_set_id,content,content_hash,size,mtime_ms) VALUES ('actual-file',$1,'retained-source-path','actual-set',$2,$3,$4,1)`,
      [fileName, original, hash(original), Buffer.byteLength(original)]
    );
    await build({
      ...MAIN_PROCESS_BUILD_OPTIONS,
      entryPoints: { 'canonical-proof': 'src/__tests__/fixtures/canonical-indexer-node-proof.ts' },
      logLevel: 'silent',
      outdir: fixtureDirectory,
    });
    const child = fork(path.join(fixtureDirectory, 'canonical-proof.js'), [], {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const parent = new CanonicalUtilityParent(
      (frame) => {
        child.send(frame);
      },
      (error) => child.emit('error', error)
    );
    const connection = createIndexerConnection(
      {
        dbPath: path.join(directory, 'search.sqlite'),
        embedding: { indexMode: 'text-only' },
        fileBindings: [{ ...nativeIdentity(identity), profile }],
        rootIds: [],
        scopes: [scope],
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
          const message = (frame: unknown): void => {
            if (isCanonicalFrame(frame)) {
              parent.receive(frame);
            } else {
              listener(frame);
            }
          };
          child.on('message', message);
          return () => {
            child.off('message', message);
          };
        },
        send: (frame) => {
          child.send(frame);
        },
      }
    );
    try {
      const port = await connection.ready;
      const info = await port.info();
      expect(info.pid).toBe(child.pid);
      expect(info.pid).not.toBe(process.pid);
      expect(info.writerThreadId).toBeGreaterThan(0);
      expect(info.readerQueryOnly).toBe(1);
      const plans = new Map<string, ScopedFilePlan>();
      const catalog = createNativeCanonicalCatalog({
        database: db,
        joinNativeRemoval: async (files, removalScope) => {
          for (const file of files) {
            await port.removeScopedFile({ fileId: file.fileId, scope: removalScope });
          }
        },
        replaceTrustedBindings: async () => {
          await port.replaceFileBindings([{ ...nativeIdentity(identity), profile }]);
        },
        resolveProfile: async (requested, _authority, context) => {
          if (mode !== 'VECTOR') {
            throw new Error('TEXT requested inference');
          }
          return resolver.resolveProfile({ scope: requested }, context);
        },
        resolveScope: async (requested) => {
          expect(requested).toEqual(scope);
          return {
            assertCurrent: () => {},
            assertDiscoveredSource: () => {
              throw new Error('Rootless discovered a filesystem source');
            },
            embeddingSetId: scope.embeddingSetId,
            resolveIdentity: (record) => ({
              ...identity,
              embeddingSetId: record.embeddingSetId,
              fileId: record.fileId,
              fileName: record.fileName,
              rootId: record.rootId,
            }),
          };
        },
      });
      const verify = async (files: readonly CanonicalManifestFile[]) => {
        const proof = await port.verifyScopedManifest({
          files: files.map((file) => ({
            ...nativeIdentity(file),
            chunks: (plans.get(file.fileId)?.chunks ?? []).map((chunk) => ({
              chunkId: chunk.chunkId,
              chunkIndex: chunk.chunkIndex,
              chunkSize: chunk.chunkSize,
              chunkType: chunk.chunkType,
              contentHash: chunk.contentHash,
              endLine: chunk.endLine,
              endOffset: chunk.endOffset,
              startLine: chunk.startLine,
              startOffset: chunk.startOffset,
              tokenCount: chunk.tokenCount,
            })),
            contentHash: file.contentHash,
          })),
          scope,
        });
        const byId = new Map(files.map((file) => [file.fileId, file]));
        const selected = (ids: readonly { fileId: string }[]): CanonicalManifestFile[] =>
          ids.map((file) => {
            const canonical = byId.get(file.fileId);
            if (!canonical) {
              throw new Error('Native proof returned a foreign identity');
            }
            return canonical;
          });
        return {
          changed: selected(proof.changed),
          complete: proof.complete,
          missing: selected(proof.missing),
          storeId: proof.storeId,
          unexpected: selected(proof.unexpected),
        };
      };
      const publication: CanonicalPublicationPort = {
        abortScan: async () => {},
        beginScan: async ({ requestId, scope }) => ({
          generation: 1,
          requestId,
          scope,
          storeId: info.storeId,
        }),
        commitTextFile: async ({ file, payload }) => {
          const plan = await port.prepareScopedFile({
            snapshot: {
              ...nativeIdentity(file),
              content: payload.content,
              providedChunks: payload.providedChunks,
            },
          });
          await port.commitScopedTextFile({
            plan,
            ...(payload.syntax ? { syntax: payload.syntax } : {}),
          });
          plans.set(file.fileId, plan);
        },
        finishScan: async ({ aborted, errors, files, full, ticket, truncatedDirectories }) => {
          if (aborted) {
            return { reason: 'aborted', scanComplete: false, ticket };
          }
          if (errors.length > 0) {
            return { reason: 'scan-errors', scanComplete: false, ticket };
          }
          if (!full) {
            return { reason: 'partial', scanComplete: false, ticket };
          }
          if (truncatedDirectories.length > 0) {
            return { reason: 'truncated', scanComplete: false, ticket };
          }
          expect((await verify(files)).complete).toBe(true);
          return { reason: 'complete', scanComplete: true, ticket };
        },
        removeFile: async ({ file, ticket }) => {
          await port.removeScopedFile({ fileId: file.fileId, scope: ticket.scope });
        },
        verifyManifest: ({ files }) => verify(files),
      };
      const vectorPublication: CanonicalVectorPublicationPort = {
        ...publication,
        commitVectorFile: async ({ file, plan, profile: selected, embeddings, syntax }) => {
          await port.commitScopedFile({
            embeddings,
            plan,
            profile: selected,
            ...(syntax ? { syntax } : {}),
          });
          plans.set(file.fileId, plan);
        },
        prepareVectorFile: async ({ file, payload, profile: selected }) =>
          port.prepareScopedFile({
            profile: selected,
            snapshot: {
              ...nativeIdentity(file),
              content: payload.content,
              providedChunks: payload.providedChunks,
            },
          }),
        vectorCoverage: (request) => port.coverageScope(request),
        verifyVectorManifest: (request) => port.verifyScopedManifest(request),
      };
      const attachment = await parent.attachCollection({
        ...(mode === 'VECTOR'
          ? { inference, mode: 'VECTOR' as const, publication: vectorPublication }
          : { mode: 'TEXT' as const, publication }),
        catalog,
        parser: { parser: 'oxc' },
        request: { batchSize: 2, chunkingOptions: { strategy: 'auto' }, maxFileBytes: 1024 },
        scope,
        source: {
          indexingPolicyPreset: 'balanced',
          inventory: {
            loadFiles: async (requested, context) =>
              catalog.loadAuthorizedBatch({ files: [identity], scope: requested }, context),
            readRetained: (file, maxBytes, context) =>
              catalog.readRetainedSource(file, maxBytes, scope, context),
          },
        },
      });
      expect((await attachment.scan('first-scan')).scanComplete).toBe(true);
      expect(
        (
          await port.searchScopes({
            limit: 10,
            mode: 'bm25',
            scopes: [scope],
            text: 'firstversion',
          })
        ).hits
      ).toHaveLength(1);
      const result = await db.query<{ content: string; chunks_count: number }>(
        'SELECT content,chunks_count FROM file_records WHERE id=$1',
        ['actual-file']
      );
      expect(result.rows[0]?.content).toBe(original);
      expect(result.rows[0]?.chunks_count).toBeGreaterThan(0);
      // Every committed chunk is its own source span with words of its own: no
      // lone `export` or `}` whose identical vector outranks real content.
      const chunks = plans.get(identity.fileId)?.chunks ?? [];
      expect(
        chunks.map((chunk) =>
          chunk.startOffset === null || chunk.endOffset === null
            ? null
            : original.slice(chunk.startOffset, chunk.endOffset)
        )
      ).toEqual(chunks.map((chunk) => chunk.content));
      const committed = chunks.map((chunk) => chunk.content);
      expect(
        committed.filter((text) => !/[\p{L}\p{N}_$]/u.test(text) || text === 'export')
      ).toEqual([]);
      const declaration = DECLARATION_START[fileName];
      if (declaration) {
        expect(committed.filter((text) => text.startsWith(declaration))).toHaveLength(1);
      }
      if (profile) {
        expect((await port.coverageScope({ profile, scope })).vectorCoverageComplete).toBe(true);
        const queryVector =
          provider === 'cohere'
            ? (
                await generateHostedEmbeddings({
                  dimensions: profile.dimensions,
                  modelId: metadata.modelId,
                  provider,
                  purpose: 'query',
                  signal: new AbortController().signal,
                  texts: ['find canonical source'],
                })
              )[0]!
            : new Array<number>(profile.dimensions).fill(1);
        expect(
          (
            await port.searchScopes({
              limit: 10,
              mode: 'vector',
              profile,
              scopes: [scope],
              vector: queryVector,
            })
          ).hits[0]?.fileId
        ).toBe(identity.fileId);
        const generated = inference.generate.mock.calls.length;
        expect((await attachment.scan('covered-scan')).scanComplete).toBe(true);
        expect(inference.generate).toHaveBeenCalledTimes(generated);
      }
      original = sourceText(fileName, 'secondversion');
      await db.query(
        'UPDATE file_records SET content=$1,content_hash=$2,size=$3,mtime_ms=2,chunks_processed_at=NULL WHERE id=$4',
        [original, hash(original), Buffer.byteLength(original), identity.fileId]
      );
      expect((await attachment.scan('second-scan')).scanComplete).toBe(true);
      expect(
        (
          await port.searchScopes({
            limit: 10,
            mode: 'bm25',
            scopes: [scope],
            text: 'firstversion',
          })
        ).hits
      ).toHaveLength(0);
      expect(
        (
          await port.searchScopes({
            limit: 10,
            mode: 'bm25',
            scopes: [scope],
            text: 'secondversion',
          })
        ).hits
      ).toHaveLength(1);
      expect(documentEmbeddings.mock.calls.length).toBe(
        mode === 'VECTOR' && provider === 'local' ? 2 : 0
      );
      if (provider === 'cohere') {
        expect(hostedFetch).toHaveBeenCalledTimes(3);
      }
      const ids = inference.generate.mock.calls.map(([request]) => request.requestId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(inference.join.mock.calls.map(([requestId]) => requestId)).toEqual(ids);
      if (mode === 'VECTOR') {
        let entered!: () => void;
        let aborted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const stopped = new Promise<void>((resolve) => {
          aborted = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        physicalHold = { aborted, entered, released };
        original = sourceText(fileName, 'thirdversion');
        await db.query(
          'UPDATE file_records SET content=$1,content_hash=$2,size=$3,mtime_ms=3,chunks_processed_at=NULL WHERE id=$4',
          [original, hash(original), Buffer.byteLength(original), identity.fileId]
        );
        const scan = attachment.scan('physically-cancelled-scan').then(
          (receipt) => ({ receipt }),
          (error: unknown) => ({ error })
        );
        await started;
        let joined = false;
        const cancel = attachment.cancel().then(() => {
          joined = true;
        });
        await stopped;
        await Promise.resolve();
        expect(joined).toBe(false);
        release();
        await cancel;
        expect(await scan).toMatchObject({
          error: { message: 'Canonical scan cancelled.', name: 'AbortError' },
        });
        expect(
          (
            await db.query<{ chunks_processed_at: unknown }>(
              'SELECT chunks_processed_at FROM file_records WHERE id=$1',
              [identity.fileId]
            )
          ).rows[0]?.chunks_processed_at
        ).toBeNull();
        expect(
          (
            await port.searchScopes({
              limit: 10,
              mode: 'bm25',
              scopes: [scope],
              text: 'thirdversion',
            })
          ).hits
        ).toHaveLength(0);
        const cancelledId = inference.generate.mock.calls.at(-1)?.[0].requestId;
        expect(cancelledId).toBeDefined();
        expect(inference.cancel).toHaveBeenCalledWith(cancelledId);
        expect(inference.join).toHaveBeenLastCalledWith(cancelledId);
      }
      await attachment.close();
      await parent.close();
      await connection.close();
      await ownedInference.close();
      expect(await exit).toEqual({ code: 0, signal: null });
      expect(connection.exited).toBe(true);
      expect(stderr).not.toContain('Unhandled');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await parent.close();
      await connection.close();
      await db.close();
      await rm(fixtureDirectory, { force: true, recursive: true });
      await rm(directory, { force: true, recursive: true });
    }
  },
  20_000
);
