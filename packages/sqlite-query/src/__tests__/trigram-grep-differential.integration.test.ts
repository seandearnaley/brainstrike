import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import recorded from '@brainstrike/test-utils/fixtures/recorded-grep-patterns.json' with {
  type: 'json',
};
import { createGrepLineMatcher } from '@brainstrike/utils/grep-line-matcher';
import { planGrepTrigramCandidates } from '@brainstrike/utils/grep-trigram-plan';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SqliteGrepOptions, SqliteValue } from '../protocol.js';
import { SqliteSandbox } from '../sandbox.js';

const directory = mkdtempSync(join(tmpdir(), 'brainstrike-trigram-grep-'));
const databasePath = join(directory, 'index.sqlite');
let rootId: string;
let sandbox: SqliteSandbox;
/** Every authorized chunk in grep's own projection and order, read once without any filter. */
let corpus: (readonly SqliteValue[])[];

beforeAll(() => {
  const writer = process.env['INDEXER_TEST_EXEC_PATH'];
  if (!writer) {
    throw new Error('An explicit qualified Node writer executable is required.');
  }
  const built = spawnSync(
    writer,
    ['src/__tests__/fixtures/build-grep-corpus.mjs', databasePath, '160', '100'],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }
  );
  if (built.status !== 0) {
    throw new Error(`Generated IndexerPort corpus failed: ${built.stderr}`);
  }
  const summary = JSON.parse(built.stdout) as { chunks: number; rootId: string };
  rootId = summary.rootId;
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = reader.prepare(
      'SELECT ch.id,ch.root_id,ch.file_record_id,fr.path,ch.content,ch.content_hash,ch.start_line,ch.end_line,ch.chunk_index,ch.chunk_size,ch.chunk_type,ch.start_offset,ch.end_offset,ch.token_count FROM file_chunks ch JOIN file_records fr ON fr.id=ch.file_record_id AND fr.root_id IS ch.root_id WHERE ch.root_id=? ORDER BY fr.path,ch.id'
    );
    statement.setReturnArrays(true);
    corpus = statement.all(rootId) as unknown as (readonly SqliteValue[])[];
  } finally {
    reader.close();
  }
  expect(corpus).toHaveLength(summary.chunks);
  sandbox = new SqliteSandbox(databasePath);
}, 120_000);

afterAll(() => {
  sandbox?.close();
  rmSync(directory, { force: true, recursive: true });
});

type Outcome =
  | { readonly error: string }
  | {
      readonly matchedChunks: number;
      readonly rows: readonly (readonly SqliteValue[])[];
      readonly truncated: boolean;
    };

/** The exhaustive oracle: the canonical line matcher over every chunk, then the row cap. */
function exhaustive(options: SqliteGrepOptions): Outcome {
  let matcher: ReturnType<typeof createGrepLineMatcher>;
  try {
    matcher = createGrepLineMatcher(options.pattern, options.isRegex, options.caseSensitive);
  } catch (error) {
    return { error: String(error) };
  }
  const matched = corpus.filter((row) =>
    String(row[4])
      .split('\n')
      .some((line) => matcher.matches(line))
  );
  return {
    matchedChunks: matched.length,
    rows: matched.slice(0, options.maxRows),
    truncated: matched.length > options.maxRows,
  };
}

function accelerated(options: SqliteGrepOptions): Outcome {
  try {
    const { matchedChunks, rows, truncated } = sandbox.grep(options);
    return { matchedChunks, rows, truncated };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Compares every case; returns how many used trigram candidates and matched something. */
function expectIdentical(cases: readonly SqliteGrepOptions[]): {
  candidates: number;
  matching: number;
} {
  let candidates = 0;
  let matching = 0;
  for (const options of cases) {
    const expected = exhaustive(options);
    const actual = accelerated(options);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      // Fail with the full diff for the first differing pattern.
      expect({ options, outcome: actual }).toEqual({ options, outcome: expected });
    }
    if (
      planGrepTrigramCandidates(options.pattern, options.isRegex, options.caseSensitive).kind ===
      'candidates'
    ) {
      candidates += 1;
      if ('matchedChunks' in expected && expected.matchedChunks > 0) {
        matching += 1;
      }
    }
  }
  return { candidates, matching };
}

it('returns byte-identical rows to the exhaustive scan for every recorded pattern', () => {
  const base = { maxRows: 50, rootIds: [rootId] };
  const cases = recorded.patterns.flatMap(({ caseInsensitive, pattern }, index) => [
    { ...base, caseSensitive: !caseInsensitive, isRegex: true, pattern },
    // Each recorded pattern as a literal too, both cases, on a third of them.
    ...(index % 3 === 0
      ? [
          { ...base, caseSensitive: true, isRegex: false, pattern },
          { ...base, caseSensitive: false, isRegex: false, pattern },
        ]
      : []),
  ]);
  const { candidates, matching } = expectIdentical(cases);
  // The comparison exercises the accelerated path, and on patterns that match.
  expect(candidates).toBeGreaterThan(cases.length / 2);
  expect(matching).toBeGreaterThan(candidates / 4);
}, 300_000);

it('returns byte-identical rows for case-folding edge literals and capped results', () => {
  const words = ['xai', 'XAI', 'kelvin', 'marker', 'MARKER', 'state', 'élan', 'cafe', 'café'];
  const cases = words.flatMap((pattern) =>
    [true, false].flatMap((caseSensitive) =>
      [true, false].map((isRegex) => ({
        caseSensitive,
        isRegex,
        maxRows: 3,
        pattern,
        rootIds: [rootId],
      }))
    )
  );
  expectIdentical(cases);
});
