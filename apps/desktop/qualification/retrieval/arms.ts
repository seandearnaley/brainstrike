/**
 * BST-1939 Phase 0: the candidate arms, over a fresh native index built from
 * the recorded canonical chunks and vectors through the public IndexerPort.
 * BM25, trigram and vector are the native index's own searches; vector uses
 * the recorded query vectors, so no model runs. Grep has two sources: the
 * 2026-10-03 policy (the canonical line matcher over chunk lines in path and
 * chunk order) for the control, and the native killable reader's grep, which
 * product search uses today.
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CandidatePool, EvaluationHit, RetrievalArm } from '@brainstrike/agent';
import { embeddingProfileHash, openIndexer } from '@brainstrike/indexer';
import { createGrepLineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { z } from 'zod';
import {
  chunkKey,
  type EmbeddingProfile,
  type RecordedEvidence,
  type VectorSet,
} from './evidence.ts';

type Port = Awaited<ReturnType<typeof openIndexer>>;
type Profile = Parameters<typeof embeddingProfileHash>[0];
export type GrepSource = 'recorded-policy' | 'native-reader';
/** Grep pools by query: the recorded policy computes them; product grep answers them up front. */
export type GrepPools =
  | { readonly kind: 'recorded-policy' }
  | {
      readonly kind: 'native-reader';
      readonly pools: ReadonlyMap<string, CandidatePool>;
    };
export type ArmSearch = (arm: RetrievalArm, query: string, limit: number) => Promise<CandidatePool>;

/** The recorded measurement's explicit deadlines, with room for the full corpus. */
const DEADLINES = { closeMs: 5000, exitMs: 5000, requestMs: 60_000, startupMs: 60_000 };

export interface NativeCorpus {
  /** Native chunk IDs by `relativePath:chunkIndex:contentHash`. */
  readonly chunkIds: ReadonlyMap<string, string>;
  readonly databasePath: string;
  readonly port: Port;
  readonly profile: Profile;
  readonly profileHash: string;
  /** The vector set this index holds; its query rows answer vector search. */
  readonly vectors: VectorSet;
}

/** Commits every recorded file with its provided chunks and one vector set's vectors, then reopens. */
export async function buildNativeCorpus(
  evidence: RecordedEvidence,
  vectors: VectorSet,
  embedding: EmbeddingProfile,
  directory: string
): Promise<NativeCorpus> {
  // Device, pooling and normalization are measured producer facts, not native identity (ADR-0018).
  const {
    device: _device,
    normalization: _normalization,
    pooling: _pooling,
    ...profile
  } = embedding;
  const databasePath = join(directory, 'index.sqlite');
  const options = {
    dbPath: databasePath,
    embedding: { indexMode: 'vector-configured', profile },
    rootIds: [evidence.rootId],
  } as const;
  const chunkIds = new Map<string, string>();
  const writer = await openIndexer(options, DEADLINES);
  try {
    for (const file of evidence.files) {
      const plan = await writer.prepareFile({
        content: await readFile(join(evidence.directory, 'sources', file.relativePath), 'utf8'),
        fileId: file.fileId,
        providedChunks: file.result.chunks,
        relativePath: file.relativePath,
        rootId: evidence.rootId,
      });
      const missing = new Set(plan.embeddingChunkIds);
      const embeddings = plan.chunks.flatMap((chunk) => {
        const key = chunkKey(file.relativePath, chunk.chunkIndex ?? -1, chunk.contentHash);
        const vector = vectors.chunks.get(key);
        if (!vector) {
          throw new Error(`No recorded vector for ${key}`);
        }
        chunkIds.set(key, chunk.chunkId);
        return missing.has(chunk.chunkId) ? [{ chunkId: chunk.chunkId, vector: [...vector] }] : [];
      });
      await writer.commitFile({ embeddings, plan, profile });
    }
  } finally {
    await writer.close();
  }
  // As the recorded measurement did: search only after reopening the committed database.
  const port = await openIndexer(options, DEADLINES);
  return {
    chunkIds,
    databasePath,
    port,
    profile,
    profileHash: embeddingProfileHash(profile),
    vectors,
  };
}

/** The 2026-10-03 grep policy: full query, case-insensitive line literal, path then chunk order. */
export function recordedPolicyGrep(
  evidence: Pick<RecordedEvidence, 'files'>,
  chunkIds: ReadonlyMap<string, string>,
  query: string,
  limit: number
): { readonly candidates: readonly string[]; readonly hits: EvaluationHit[] } {
  const matcher = createGrepLineMatcher(query, false, false);
  const matched = evidence.files
    .flatMap((file) =>
      file.result.chunks.map((chunk) => ({ ...chunk, relativePath: file.relativePath }))
    )
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.chunkIndex - b.chunkIndex)
    .filter((chunk) => chunk.content.split('\n').some((line) => matcher.matches(line)));
  const keys = matched.map((chunk) =>
    chunkKey(chunk.relativePath, chunk.chunkIndex, chunk.contentHash)
  );
  return {
    candidates: keys,
    hits: matched.slice(0, limit).map((chunk, index) => {
      const chunkId = chunkIds.get(keys[index] ?? '');
      if (!chunkId) {
        throw new Error(`No native chunk for ${keys[index]}`);
      }
      return {
        chunkId,
        content: chunk.content,
        endLine: chunk.endLine,
        endOffset: chunk.endOffset,
        relativePath: chunk.relativePath,
        score: 0,
        startLine: chunk.startLine,
        startOffset: chunk.startOffset,
      };
    }),
  };
}

const nativeGrepSchema = z.array(
  z.object({
    columns: z.array(z.string()),
    matchedChunks: z.number().int().nonnegative(),
    query: z.string(),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  })
);

/**
 * Product grep for every query, through the killable SQLite reader. It runs in
 * Electron-as-Node (native-grep.ts): the reader process is Electron's, and its
 * client must share Electron's V8 serialization.
 */
export async function nativeReaderGrep(input: {
  readonly corpus: NativeCorpus;
  readonly directory: string;
  readonly electronExecutable: string;
  readonly queries: readonly string[];
  readonly rootId: string;
}): Promise<GrepPools> {
  const queriesPath = join(input.directory, 'grep-queries.json');
  const outPath = join(input.directory, 'grep-pools.json');
  await writeFile(queriesPath, JSON.stringify(input.queries));
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['ELECTRON_RUN_AS_NODE'] = '1';
  await promisify(execFile)(
    input.electronExecutable,
    [
      join(import.meta.dirname, 'native-grep.ts'),
      input.corpus.databasePath,
      input.rootId,
      queriesPath,
      outPath,
    ],
    { env, maxBuffer: 16 * 1024 * 1024 }
  );
  const pools = new Map<string, CandidatePool>();
  for (const result of nativeGrepSchema.parse(JSON.parse(await readFile(outPath, 'utf8')))) {
    const column = (name: string): number => {
      const index = result.columns.indexOf(name);
      if (index < 0) {
        throw new TypeError(`Native grep has no ${name} column.`);
      }
      return index;
    };
    const at = {
      content: column('content'),
      end: column('end_line'),
      endOffset: column('end_offset'),
      id: column('id'),
      path: column('path'),
      start: column('start_line'),
      startOffset: column('start_offset'),
    };
    const text = (row: readonly (string | number | null)[], index: number): string => {
      const value = row[index];
      if (typeof value !== 'string') {
        throw new TypeError('Native grep returned a non-text column.');
      }
      return value;
    };
    const integer = (row: readonly (string | number | null)[], index: number): number => {
      const value = row[index];
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError('Native grep returned a non-integer column.');
      }
      return value;
    };
    pools.set(result.query, {
      candidateCount: result.matchedChunks,
      hits: result.rows.map((row) => ({
        chunkId: text(row, at.id),
        content: text(row, at.content),
        endLine: integer(row, at.end),
        endOffset: integer(row, at.endOffset),
        relativePath: text(row, at.path),
        score: 0,
        startLine: integer(row, at.start),
        startOffset: integer(row, at.startOffset),
      })),
      profileHash: input.corpus.profileHash,
    });
  }
  return { kind: 'native-reader', pools };
}

/** The arms over one native corpus, with grep from the requested source. */
export function openArms(input: {
  readonly corpus: NativeCorpus;
  readonly evidence: RecordedEvidence;
  readonly grep: GrepPools;
  /** Query text to its frozen fixture ID, which names its recorded query vector. */
  readonly queryIds: ReadonlyMap<string, string>;
}): ArmSearch {
  const { corpus, evidence } = input;
  const grep = (query: string, limit: number): CandidatePool => {
    if (input.grep.kind === 'native-reader') {
      const pool = input.grep.pools.get(query);
      if (!pool || limit !== 100) {
        throw new Error(`No product grep pool of ${limit} for ${query}`);
      }
      return pool;
    }
    const { candidates, hits } = recordedPolicyGrep(evidence, corpus.chunkIds, query, limit);
    return { candidateCount: candidates.length, hits, profileHash: corpus.profileHash };
  };
  const search: ArmSearch = async (arm, query, limit) => {
    if (arm === 'grep') {
      return grep(query, limit);
    }
    const queryId = input.queryIds.get(query);
    const vector = queryId === undefined ? undefined : corpus.vectors.queries.get(queryId);
    if (!vector) {
      throw new Error(`No recorded query vector for ${query}`);
    }
    const result = await corpus.port.search(
      arm === 'vector'
        ? {
            limit,
            mode: arm,
            profile: corpus.profile,
            rootIds: [evidence.rootId],
            vector: [...vector],
          }
        : { limit, mode: arm, rootIds: [evidence.rootId], text: query }
    );
    if (
      result.embedding.indexMode !== 'vector-configured' ||
      result.embedding.profileHash !== corpus.profileHash
    ) {
      throw new Error('Native search answered for a different embedding profile.');
    }
    return {
      candidateCount: result.candidateCount,
      hits: result.hits.map((hit) => ({
        chunkId: hit.chunkId,
        content: hit.content,
        endLine: hit.endLine,
        ...(hit.endOffset === null ? {} : { endOffset: hit.endOffset }),
        relativePath: hit.relativePath,
        score: hit.score,
        startLine: hit.startLine,
        ...(hit.startOffset === null ? {} : { startOffset: hit.startOffset }),
      })),
      profileHash: result.embedding.profileHash,
    };
  };
  return search;
}
