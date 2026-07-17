/**
 * Hand-authored golden set for the built-in full-text search arm.
 *
 * No embeddings — fullTextSearch never touches them. Each file carries one
 * chunk; queries name the single most-relevant chunk (`expectedChunkId`) so
 * the runner can score precision@1 and MRR. The corpus is deliberately
 * IDF-discriminating: "workspace" appears in EVERY document (near-zero IDF),
 * several medium-frequency terms cluster topically, and each query's target
 * owes its relevance to a rare, informative term. That query intentionally
 * records built-in `ts_rank`'s known frequency bias while the remaining
 * queries guard the corruption-safe baseline.
 */

export interface LexicalGoldenFile {
  content: string;
  id: string;
  name: string;
  path: string;
}

export interface LexicalGoldenQuery {
  expectedChunkId: string;
  id: string;
  text: string;
}

export interface LexicalGoldenDataset {
  files: LexicalGoldenFile[];
  name: string;
  queries: LexicalGoldenQuery[];
  version: string;
}

const FILES: LexicalGoldenFile[] = [
  {
    content:
      'The workspace indexing pipeline batches file chunks and retries failed batches with backoff.',
    id: 'lex-file-01',
    name: 'indexing-pipeline.md',
    path: '/lex/indexing-pipeline.md',
  },
  {
    content:
      'The workspace scheduler leases jobs from the queue and expires stale leases after a timeout.',
    id: 'lex-file-02',
    name: 'scheduler-leases.md',
    path: '/lex/scheduler-leases.md',
  },
  {
    content:
      'Workspace search fuses the vector pipeline with keyword matching using reciprocal rank fusion.',
    id: 'lex-file-03',
    name: 'hybrid-fusion.md',
    path: '/lex/hybrid-fusion.md',
  },
  {
    content:
      'Rotation math in the workspace renderer converts Euler angles into a quaternion before interpolation.',
    id: 'lex-file-04',
    name: 'quaternion-rotation.md',
    path: '/lex/quaternion-rotation.md',
  },
  {
    content:
      'The workspace embedding worker throttles batches so the pipeline never starves foreground queries.',
    id: 'lex-file-05',
    name: 'embedding-throttle.md',
    path: '/lex/embedding-throttle.md',
  },
  {
    content:
      'Workspace credentials live in the encrypted keychain; the renderer never sees a raw provider secret.',
    id: 'lex-file-06',
    name: 'keychain-credentials.md',
    path: '/lex/keychain-credentials.md',
  },
  {
    content:
      'The workspace migration runner wraps every schema change in a transaction and rolls back on failure.',
    id: 'lex-file-07',
    name: 'migration-runner.md',
    path: '/lex/migration-runner.md',
  },
  {
    content:
      'Workspace snapshots capture the selection pipeline state so a report can be regenerated deterministically.',
    id: 'lex-file-08',
    name: 'selection-snapshots.md',
    path: '/lex/selection-snapshots.md',
  },
  {
    content:
      'The workspace grep tool prefilters candidates with trigram indexes before exact line matching.',
    id: 'lex-file-09',
    name: 'grep-trigram.md',
    path: '/lex/grep-trigram.md',
  },
  {
    content:
      'Workspace notifications fire only while the window is unfocused, coalesced per run identifier.',
    id: 'lex-file-10',
    name: 'run-notifications.md',
    path: '/lex/run-notifications.md',
  },
  {
    content:
      'The workspace pipeline pipeline pipeline stage list repeats the pipeline word for stress testing.',
    id: 'lex-file-11',
    name: 'pipeline-stuffed.md',
    path: '/lex/pipeline-stuffed.md',
  },
  {
    content:
      'Workspace factory reset wipes the database, IndexedDB, and cache storage for a true fresh start.',
    id: 'lex-file-12',
    name: 'factory-reset.md',
    path: '/lex/factory-reset.md',
  },
  {
    content:
      'The workspace scheduler in the pipeline uses an idempotency fingerprint to deduplicate enqueued work.',
    id: 'lex-file-13',
    name: 'dedupe-fingerprint.md',
    path: '/lex/dedupe-fingerprint.md',
  },
  {
    content:
      'Workspace markdown previews render mermaid diagrams lazily and keep raw HTML inert for safety.',
    id: 'lex-file-14',
    name: 'markdown-preview.md',
    path: '/lex/markdown-preview.md',
  },
  {
    content:
      'The workspace context meter derives one token budget that feeds the limiter, meter, and prompt note.',
    id: 'lex-file-15',
    name: 'context-budget.md',
    path: '/lex/context-budget.md',
  },
];

const QUERIES: LexicalGoldenQuery[] = [
  {
    // IDF discrimination (explicit OR — websearch's default is AND, and no doc
    // carries both terms): "pipeline" is common (6 docs, incl. the stuffed
    // lex-file-11 with 4 occurrences) while "quaternion" appears once. The old BM25
    // IDF must rank the rare-term target above the saturated-frequency stuffed
    // doc; a frequency-only ranker would not.
    expectedChunkId: 'lex-chunk-04',
    id: 'lex-q1-idf-rare-term',
    text: 'quaternion OR pipeline',
  },
  {
    expectedChunkId: 'lex-chunk-06',
    id: 'lex-q2-keychain',
    text: 'encrypted keychain secret',
  },
  {
    expectedChunkId: 'lex-chunk-13',
    id: 'lex-q3-multi-term',
    text: 'idempotency fingerprint deduplicate',
  },
  {
    // websearch-mode quoted phrase must match and rank the fusion doc first.
    expectedChunkId: 'lex-chunk-03',
    id: 'lex-q4-websearch-phrase',
    text: '"reciprocal rank fusion"',
  },
  {
    expectedChunkId: 'lex-chunk-09',
    id: 'lex-q5-trigram',
    text: 'trigram prefilter grep',
  },
];

export const lexicalGoldenDataset: LexicalGoldenDataset = {
  files: FILES,
  name: 'lexical-golden',
  queries: QUERIES,
  version: '1',
};

/** Chunk id derived from the file id — one chunk per golden file. */
export function lexicalChunkIdForFile(fileId: string): string {
  return fileId.replace('lex-file-', 'lex-chunk-');
}
