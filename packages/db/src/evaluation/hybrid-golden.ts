/**
 * Hand-authored golden set for the HYBRID (vector + BM25, RRF-fused) arm.
 *
 * Designed so that NEITHER arm alone ranks any target first, but the fusion
 * ranks EVERY target first — the property this eval gates:
 *
 * Per query the corpus carries three documents:
 *  - TARGET   — contains every query term once AND sits semantically close to
 *               the query embedding, but is rank 2 in BOTH arms.
 *  - VECTOR distractor — closest embedding (vector rank 1) but missing the
 *               query terms, so the websearch-AND tsquery never matches it
 *               (absent from the lexical list).
 *  - LEXICAL distractor — term-stuffed (BM25 rank 1) but embedded on the
 *               NEGATIVE query axis, below the 0.5 similarity threshold
 *               (absent from the vector list).
 *
 * RRF (k = 60): target = 1/62 + 1/62 ≈ 0.0323 beats each single-arm leader's
 * 1/61 ≈ 0.0164, so fusion places the target first while each pure arm fails.
 */

export interface HybridGoldenChunk {
  content: string;
  embedding: number[];
  id: string;
}

export interface HybridGoldenFile {
  chunks: HybridGoldenChunk[];
  id: string;
  name: string;
  path: string;
}

export interface HybridGoldenQuery {
  embedding: number[];
  expectedChunkId: string;
  id: string;
  /** The single-arm leaders fusion must beat (documents the designed gap). */
  lexicalDistractorChunkId: string;
  text: string;
  vectorDistractorChunkId: string;
}

export interface HybridGoldenDataset {
  embeddingSet: {
    dimensions: number;
    distance: 'cosine' | 'ip' | 'l2';
    modelId: string;
    modelKey: string;
  };
  files: HybridGoldenFile[];
  name: string;
  queries: HybridGoldenQuery[];
  version: string;
}

function file(id: string, name: string, chunk: HybridGoldenChunk): HybridGoldenFile {
  return { chunks: [chunk], id, name, path: `/hyb/${name}` };
}

const FILES: HybridGoldenFile[] = [
  // Query 1 — "tapestry annealing renderer"
  file('hyb-file-t1', 'tapestry-annealing.md', {
    content: 'The tapestry annealing renderer blends curated context ranges into the preview pane.',
    embedding: [0.8, 0.2, 0],
    id: 'hyb-chunk-t1',
  }),
  file('hyb-file-v1', 'preview-blending.md', {
    content: 'Curated context ranges blend into the live preview pane after warmup completes.',
    embedding: [0.99, 0.01, 0],
    id: 'hyb-chunk-v1',
  }),
  file('hyb-file-l1', 'tapestry-stuffed.md', {
    content: 'tapestry annealing renderer tapestry annealing renderer tapestry annealing renderer',
    embedding: [-1, 0, 0],
    id: 'hyb-chunk-l1',
  }),
  // Query 2 — "lease fencing scheduler"
  file('hyb-file-t2', 'lease-fencing.md', {
    content: 'The lease fencing scheduler grants each worker a fenced lease before dispatch.',
    embedding: [0.2, 0.8, 0],
    id: 'hyb-chunk-t2',
  }),
  file('hyb-file-v2', 'worker-grants.md', {
    content: 'Workers receive time-bounded grants before jobs dispatch from the queue.',
    embedding: [0.01, 0.99, 0],
    id: 'hyb-chunk-v2',
  }),
  file('hyb-file-l2', 'lease-stuffed.md', {
    content: 'lease fencing scheduler lease fencing scheduler lease fencing scheduler',
    embedding: [0, -1, 0],
    id: 'hyb-chunk-l2',
  }),
  // Query 3 — "checkpoint journal revert"
  file('hyb-file-t3', 'checkpoint-journal.md', {
    content: 'The checkpoint journal revert restores a file to its captured pre-edit state.',
    embedding: [0, 0.2, 0.8],
    id: 'hyb-chunk-t3',
  }),
  file('hyb-file-v3', 'undo-restore.md', {
    content: 'Restoring files to captured pre-edit states happens through the undo pipeline.',
    embedding: [0, 0.01, 0.99],
    id: 'hyb-chunk-v3',
  }),
  file('hyb-file-l3', 'checkpoint-stuffed.md', {
    content: 'checkpoint journal revert checkpoint journal revert checkpoint journal revert',
    embedding: [0, 0, -1],
    id: 'hyb-chunk-l3',
  }),
];

const QUERIES: HybridGoldenQuery[] = [
  {
    embedding: [1, 0, 0],
    expectedChunkId: 'hyb-chunk-t1',
    id: 'hyb-q1-tapestry',
    lexicalDistractorChunkId: 'hyb-chunk-l1',
    text: 'tapestry annealing renderer',
    vectorDistractorChunkId: 'hyb-chunk-v1',
  },
  {
    embedding: [0, 1, 0],
    expectedChunkId: 'hyb-chunk-t2',
    id: 'hyb-q2-lease',
    lexicalDistractorChunkId: 'hyb-chunk-l2',
    text: 'lease fencing scheduler',
    vectorDistractorChunkId: 'hyb-chunk-v2',
  },
  {
    embedding: [0, 0, 1],
    expectedChunkId: 'hyb-chunk-t3',
    id: 'hyb-q3-checkpoint',
    lexicalDistractorChunkId: 'hyb-chunk-l3',
    text: 'checkpoint journal revert',
    vectorDistractorChunkId: 'hyb-chunk-v3',
  },
];

export const hybridGoldenDataset: HybridGoldenDataset = {
  embeddingSet: {
    dimensions: 3,
    distance: 'cosine',
    modelId: 'hybrid-test',
    modelKey: 'test::hybrid',
  },
  files: FILES,
  name: 'hybrid-golden',
  queries: QUERIES,
  version: '1',
};
