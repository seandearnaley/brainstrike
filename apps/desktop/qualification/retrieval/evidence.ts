/**
 * BST-1939 Phase 0: the recorded BST-1922 evidence the retrieval runner reads.
 * Every artifact must match its hash in evidence-manifest.json before it is
 * parsed; the recorded report is the single owner of the 2026-10-03 numbers.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z.strictObject({
  evidence: z.string().min(1),
  files: z.record(z.string(), sha256),
  rootId: z.string().min(1),
});
const providedChunkSchema = z.object({
  chunkIndex: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive(),
  chunkType: z.enum(['text', 'sentence', 'recursive']),
  content: z.string().min(1),
  contentHash: sha256,
  endLine: z.number().int().positive(),
  endOffset: z.number().int().positive(),
  startLine: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  tokenCount: z.number().int().positive(),
});
export const canonicalFileSchema = z.object({
  fileId: z.string().min(1),
  relativePath: z.string().min(1),
  result: z.object({ chunks: z.array(providedChunkSchema).min(1) }),
  sourceHash: sha256,
});
const vectorRowSchema = z.discriminatedUnion('kind', [
  z.object({
    chunkIndex: z.number().int().nonnegative(),
    contentHash: sha256,
    id: sha256,
    kind: z.literal('chunk'),
    relativePath: z.string().min(1),
    vectorIndex: z.number().int().nonnegative(),
  }),
  z.object({ id: z.string().min(1), kind: z.literal('query'), vectorIndex: z.number().int() }),
]);
const settingsSchema = z.object({
  options: z.object({
    maxTokens: z.number().int().positive(),
    maxTokensCap: z.number().int().positive(),
    overlap: z.number().int().nonnegative(),
    tokenTrueSizing: z.boolean(),
  }),
  producerSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  profile: z.object({
    device: z.enum(['wasm', 'webgpu']),
    dimensions: z.literal(384),
    dtype: z.enum(['q8', 'fp16', 'fp32']),
    modelId: z.string().min(1),
    normalization: z.literal('l2'),
    pooling: z.literal('mean'),
    revision: z.string().regex(/^[a-f0-9]{40}$/u),
    tokenCap: z.number().int().positive(),
  }),
});
const corpusManifestSchema = z.object({
  sources: z.array(z.object({ relativePath: z.string().min(1), sha256 })).min(1),
});
const metricsSchema = z.object({
  meanMrr: z.number(),
  meanPrecisionAtK: z.record(z.string(), z.number()),
  meanRecallAtK: z.record(z.string(), z.number()),
  successfulEvaluations: z.number().int(),
});
const poolSchema = z.object({ hits: z.array(z.object({ chunkId: sha256 })) });
const reportSchema = z.object({
  gate: z.object({ mrrDelta: z.number(), passed: z.boolean(), recallDelta: z.number() }),
  modes: z.record(z.string(), metricsSchema),
  profileHash: sha256,
  queries: z.array(
    z.object({
      id: z.string().min(1),
      pools: z.object({
        bm25: poolSchema,
        grep: poolSchema,
        trigram: poolSchema,
        vector: poolSchema,
      }),
    })
  ),
});
const grepPoolsSchema = z.object({
  results: z.array(
    z.object({
      candidateCount: z.number().int().nonnegative(),
      hits: z.array(z.object({ producerChunkId: sha256 })),
      queryId: z.string().min(1),
    })
  ),
});

export type CanonicalFile = z.infer<typeof canonicalFileSchema>;
export type RecordedReport = z.infer<typeof reportSchema>;
export type RecordedGrepPools = z.infer<typeof grepPoolsSchema>;
export type ProducerSettings = z.infer<typeof settingsSchema>;

/** One produced vector set: corpus rows by chunk identity, query rows by fixture query ID. */
export interface VectorSet {
  readonly chunks: ReadonlyMap<string, Float32Array>;
  readonly producerIds: ReadonlyMap<string, string>;
  readonly queries: ReadonlyMap<string, Float32Array>;
}

/** The embedding profile a vector set was produced under, as the harness records it. */
export type EmbeddingProfile = ProducerSettings['profile'] | CandidateProfile;
const candidateProfileSchema = z.object({
  device: z.literal('webgpu'),
  dimensions: z.literal(384),
  dtype: z.enum(['q8', 'fp16', 'fp32']),
  modelId: z.string().min(1),
  normalization: z.literal('l2'),
  pooling: z.enum(['mean', 'cls']),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  tokenCap: z.number().int().positive(),
});
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

export interface RecordedEvidence {
  readonly corpusSources: readonly { readonly relativePath: string; readonly sha256: string }[];
  readonly directory: string;
  readonly files: readonly CanonicalFile[];
  /** The recorded frozen fixture: queries and judgments as measured on 2026-10-03. */
  readonly fixture: unknown;
  readonly grepPools: RecordedGrepPools;
  /** The 2026-10-03 report: metrics, gate and every raw candidate pool. */
  readonly original: RecordedReport;
  readonly rootId: string;
  readonly settings: ProducerSettings;
  readonly vectors: VectorSet;
}

export const chunkKey = (relativePath: string, chunkIndex: number, contentHash: string): string =>
  `${relativePath}:${chunkIndex}:${contentHash}`;

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Refuses the directory unless every pinned artifact has its recorded bytes. */
export async function verifyEvidence(
  directory: string,
  manifestPath: string
): Promise<z.infer<typeof manifestSchema>> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = await fileSha256(join(directory, name));
    if (actual !== expected) {
      throw new Error(`Recorded evidence ${name} changed: expected ${expected}, found ${actual}`);
    }
  }
  return manifest;
}

const jsonLines = (text: string): unknown[] =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/**
 * Loads the verified evidence. Its own fixture.json supplies the judgments, so
 * the recorded run stays self-consistent when a judged file later moves in the repo.
 */
export async function loadEvidence(
  directory: string,
  manifestPath: string
): Promise<RecordedEvidence> {
  const manifest = await verifyEvidence(directory, manifestPath);
  const read = (name: string): Promise<string> => readFile(join(directory, name), 'utf8');
  return {
    corpusSources: corpusManifestSchema
      .parse(JSON.parse(await read('corpus-manifest.json')))
      .sources.map(({ relativePath, sha256: hash }) => ({ relativePath, sha256: hash })),
    directory,
    files: jsonLines(await read('canonical-files.jsonl')).map((row) =>
      canonicalFileSchema.parse(row)
    ),
    fixture: JSON.parse(await read('fixture.json')),
    grepPools: grepPoolsSchema.parse(JSON.parse(await read('grep-pools.json'))),
    original: reportSchema.parse(JSON.parse(await read('retrieval-report.json'))),
    rootId: manifest.rootId,
    settings: settingsSchema.parse(JSON.parse(await read('production-settings.json'))),
    vectors: await readVectorSet(directory),
  };
}

/** Reads `vectors.f32` (384 little-endian float32 per row) through `vectors-index.jsonl`. */
async function readVectorSet(directory: string): Promise<VectorSet> {
  const index = jsonLines(await readFile(join(directory, 'vectors-index.jsonl'), 'utf8')).map(
    (row) => vectorRowSchema.parse(row)
  );
  const bytes = await readFile(join(directory, 'vectors.f32'));
  const dimensions = 384;
  if (bytes.byteLength !== index.length * dimensions * 4) {
    throw new Error(`Vectors in ${directory} do not match their index rows.`);
  }
  const vector = (row: number): Float32Array =>
    Float32Array.from({ length: dimensions }, (_, column) =>
      bytes.readFloatLE((row * dimensions + column) * 4)
    );
  const chunks = new Map<string, Float32Array>();
  const producerIds = new Map<string, string>();
  const queries = new Map<string, Float32Array>();
  for (const row of index) {
    if (row.kind === 'query') {
      queries.set(row.id, vector(row.vectorIndex));
      continue;
    }
    const key = chunkKey(row.relativePath, row.chunkIndex, row.contentHash);
    chunks.set(key, vector(row.vectorIndex));
    producerIds.set(key, row.id);
  }
  return { chunks, producerIds, queries };
}

/**
 * A candidate vector set produced by produce-hidden-host-vectors.ts, refused
 * unless its artifacts match the hashes pinned for it in the repo.
 */
export async function loadCandidate(
  directory: string,
  manifestPath: string
): Promise<{
  readonly name: string;
  readonly profile: CandidateProfile;
  readonly vectors: VectorSet;
}> {
  await verifyEvidence(directory, manifestPath);
  const settings = z
    .object({ profile: candidateProfileSchema, profileName: z.string().min(1) })
    .parse(JSON.parse(await readFile(join(directory, 'embedding-settings.json'), 'utf8')));
  return {
    name: settings.profileName,
    profile: settings.profile,
    vectors: await readVectorSet(directory),
  };
}
