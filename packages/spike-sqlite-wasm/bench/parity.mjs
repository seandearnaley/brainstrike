// BST-1940 spike: FTS5 / trigram parity between the desktop engine (better-sqlite3, native) and the
// official sqlite-wasm build (the same dist/sqlite3.wasm the browser loads), on identical rows.
// Chunk corpus: #3566's generator (build-grep-corpus.mjs) run through the real IndexerPort, so the
// native side is production-built. The wasm side replays the desktop DDL and copies the same rows.
// Patterns: #3566's recorded-grep-patterns.json. Usage: node bench/parity.mjs <out.json>
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import Database from 'better-sqlite3';
import { createGrepLineMatcher } from '../../utils/dist/grep-line-matcher.js';
import { planGrepTrigramCandidates } from '../../utils/dist/grep-trigram-plan.js';
import { applyFtsConfig, replayObjects } from '../src/desktop-ddl.mjs';
import { historyMessages } from '../src/workload.mjs';

const out = process.argv[2] ?? 'parity.json';
const schema = JSON.parse(
  readFileSync(new URL('../src/desktop-schema.json', import.meta.url), 'utf8')
);
const recorded = JSON.parse(
  readFileSync(
    new URL('../../test-utils/fixtures/recorded-grep-patterns.json', import.meta.url),
    'utf8'
  )
);
const directory = mkdtempSync(join(tmpdir(), 'bst1940-parity-'));
const nativePath = join(directory, 'index.sqlite');
const builder = new URL(
  '../../sqlite-query/src/__tests__/fixtures/build-grep-corpus.mjs',
  import.meta.url
).pathname;
const built = spawnSync(process.execPath, [builder, nativePath, '160', '100'], {
  encoding: 'utf8',
});
if (built.status !== 0) {
  throw new Error(`IndexerPort corpus failed: ${built.stderr}`);
}
const summary = JSON.parse(built.stdout);
const native = new Database(nativePath, { readonly: true });
const sqlite3 = await sqlite3InitModule();
const wasm = new sqlite3.oo1.DB(':memory:', 'c');
const ddl = [
  ...replayObjects(wasm, schema.index.objects),
  ...applyFtsConfig(wasm, schema.index.ftsConfig),
];

// Copy every desktop-written row of the chunk store, column for column.
for (const table of ['index_metadata', 'file_records', 'file_chunks']) {
  const rows = native.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const columns = Object.keys(rows[0]);
  const sql = `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
  wasm.transaction(() => {
    for (const row of rows) {
      wasm.exec({ bind: columns.map((column) => row[column]), sql });
    }
  });
}

const quote = (text) => `"${text.replaceAll('"', '""')}"`;
const wasmAll = (sql, bind) => wasm.selectArrays(sql, bind);
const nativeAll = (sql, bind) =>
  native
    .prepare(sql)
    .raw(true)
    .all(...bind);
const failures = [];
const record = (kind, input, nativeRows, wasmRows) => {
  if (JSON.stringify(nativeRows) !== JSON.stringify(wasmRows)) {
    failures.push({ input, kind, native: nativeRows.slice(0, 5), wasm: wasmRows.slice(0, 5) });
  }
};

// 1. Trigram candidates (sandbox.grep's subquery) for every recorded pattern, as regex and literal.
const cases = recorded.patterns.flatMap(({ caseInsensitive, pattern }) => [
  { caseSensitive: !caseInsensitive, isRegex: true, pattern },
  { caseSensitive: true, isRegex: false, pattern },
  { caseSensitive: false, isRegex: false, pattern },
]);
for (const word of ['xai', 'XAI', 'kelvin', 'marker', 'MARKER', 'state', 'élan', 'cafe', 'café']) {
  cases.push({ caseSensitive: true, isRegex: false, pattern: word });
  cases.push({ caseSensitive: false, isRegex: false, pattern: word });
}
const corpus = nativeAll(
  'SELECT ch.pk,fr.path,ch.id,ch.content FROM file_chunks ch JOIN file_records fr ON fr.id=ch.file_record_id ORDER BY fr.path,ch.id',
  []
);
let candidatePlans = 0;
let grepMatches = 0;
for (const options of cases) {
  const plan = planGrepTrigramCandidates(options.pattern, options.isRegex, options.caseSensitive);
  let matcher;
  try {
    matcher = createGrepLineMatcher(options.pattern, options.isRegex, options.caseSensitive);
  } catch {
    continue;
  }
  const matches = (content) => content.split('\n').some((line) => matcher.matches(line));
  const exhaustive = corpus.filter((row) => matches(row[3])).map((row) => row[2]);
  if (plan.kind !== 'candidates') {
    continue;
  }
  candidatePlans += 1;
  const sql =
    'SELECT rowid FROM file_chunks_trigram WHERE file_chunks_trigram MATCH ? ORDER BY rowid';
  const nativeCandidates = nativeAll(sql, [plan.match]).map((row) => row[0]);
  const wasmCandidates = wasmAll(sql, [plan.match]).map((row) => row[0]);
  record('trigram-candidates', options, nativeCandidates, wasmCandidates);
  const allowed = new Set(wasmCandidates);
  const accelerated = corpus
    .filter((row) => allowed.has(row[0]) && matches(row[3]))
    .map((row) => row[2]);
  record('grep-vs-exhaustive', options, exhaustive, accelerated);
  grepMatches += exhaustive.length > 0 ? 1 : 0;
}

// 2. The indexer's bm25 and trigram search modes (store.ts query shape), from the same patterns' words.
const searchSql = (table) =>
  `SELECT c.id,bm25(${table}) AS score FROM ${table} JOIN file_chunks c ON c.pk=${table}.rowid JOIN file_records f ON f.root_id=c.root_id AND f.id=c.file_record_id WHERE ${table} MATCH ? AND c.root_id=? ORDER BY score,c.id LIMIT 21`;
let bm25Queries = 0;
let trigramQueries = 0;
let maxScoreDelta = 0;
let exactScores = 0;
let comparedScores = 0;
const compareScored = (kind, input, nativeRows, wasmRows) => {
  record(
    kind,
    input,
    nativeRows.map((row) => row[0]),
    wasmRows.map((row) => row[0])
  );
  nativeRows.forEach((row, index) => {
    const other = wasmRows[index]?.[1];
    if (other === undefined) {
      return;
    }
    comparedScores += 1;
    exactScores += row[1] === other ? 1 : 0;
    maxScoreDelta = Math.max(
      maxScoreDelta,
      Math.abs(row[1] - other) / Math.max(Math.abs(row[1]), 1e-300)
    );
  });
};
for (const { pattern } of recorded.patterns) {
  const expression = (pattern.match(/[\p{L}\p{N}_]+/gu) ?? []).map(quote).join(' OR ');
  if (expression) {
    bm25Queries += 1;
    const bind = [expression, summary.rootId];
    compareScored(
      'bm25',
      pattern,
      nativeAll(searchSql('file_chunks_fts'), bind),
      wasmAll(searchSql('file_chunks_fts'), bind)
    );
  }
  for (const literal of pattern
    .split(/[^A-Za-z0-9_]+/u)
    .filter((word) => word.length >= 3)
    .slice(0, 2)) {
    trigramQueries += 1;
    const bind = [quote(literal), summary.rootId];
    compareScored(
      'trigram-search',
      literal,
      nativeAll(searchSql('file_chunks_trigram'), bind),
      wasmAll(searchSql('file_chunks_trigram'), bind)
    );
  }
}

// 3. History search (state-event-store.ts search(), with snippet) on identical generated rows.
const nativeHistory = new Database(':memory:');
const nativeShim = {
  exec: (sql) =>
    typeof sql === 'string'
      ? nativeHistory.exec(sql)
      : nativeHistory.prepare(sql.sql).run(...sql.bind),
  transaction: (callback) => nativeHistory.transaction(callback)(),
};
const nativeDdl = [
  ...replayObjects(nativeShim, schema.index.objects),
  ...applyFtsConfig(nativeShim, schema.index.ftsConfig),
];
const messages = historyMessages({
  perThread: 50,
  seed: 1940,
  threads: 40,
  words: recorded.patterns,
});
for (const [engine, insert] of [
  ['native', (sql, bind) => nativeHistory.prepare(sql).run(...bind)],
  ['wasm', (sql, bind) => wasm.exec({ bind, sql })],
]) {
  const run = () => {
    for (const message of messages) {
      insert('INSERT INTO state_event_rows(pk,thread_id,seq,payload,content) VALUES(?,?,?,?,?)', [
        message.pk,
        message.threadId,
        message.seq,
        message.payload,
        message.text,
      ]);
      insert(
        'INSERT INTO state_search_rows(event_pk,thread_id,seq,run_id,role,text) VALUES(?,?,?,?,?,?)',
        [message.pk, message.threadId, message.seq, message.runId, message.role, message.text]
      );
    }
  };
  if (engine === 'native') {
    nativeHistory.transaction(run)();
  } else {
    wasm.transaction(run);
  }
}
const historySql = `SELECT s.thread_id AS threadId,s.seq,s.run_id AS runId,s.role,bm25(state_search_fts) AS rank,
  snippet(state_search_fts,0,'<mark>','</mark>',' … ',18) AS snippet
  FROM state_search_fts JOIN state_search_rows s ON s.event_pk=state_search_fts.rowid
  WHERE state_search_fts MATCH ? AND s.thread_id IN (SELECT value FROM json_each(?))
  ORDER BY rank,s.thread_id,s.seq LIMIT 20`;
const threads = JSON.stringify([...new Set(messages.map((message) => message.threadId))]);
let historyQueries = 0;
for (const { pattern } of recorded.patterns.slice(0, 400)) {
  const words = pattern.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length === 0) {
    continue;
  }
  for (const joiner of [' ', ' OR ']) {
    historyQueries += 1;
    const bind = [words.slice(0, 3).map(quote).join(joiner), threads];
    const nativeRows = nativeHistory
      .prepare(historySql)
      .raw(true)
      .all(...bind);
    const wasmRows = wasm.selectArrays(historySql, bind);
    record(
      'history-rows',
      bind[0],
      nativeRows.map((row) => [row[0], row[1], row[5]]),
      wasmRows.map((row) => [row[0], row[1], row[5]])
    );
  }
}

// 4. FTS5 integrity on the wasm side after the copy.
const integrity = {};
for (const table of [
  'file_chunks_fts',
  'file_chunks_trigram',
  'state_search_fts',
  'state_events_fts',
]) {
  try {
    wasm.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
    integrity[table] = 'ok';
  } catch (error) {
    integrity[table] = String(error.message ?? error);
  }
}

const result = {
  bm25: { comparedScores, exactScores, maxRelativeScoreDelta: maxScoreDelta, queries: bm25Queries },
  corpus: {
    chunks: summary.chunks,
    nativeSqlite: native.prepare('SELECT sqlite_version()').pluck().get(),
  },
  ddl: {
    native: nativeDdl.filter((outcome) => outcome.outcome === 'error'),
    wasm: ddl.filter((outcome) => outcome.outcome === 'error'),
  },
  failureCount: failures.length,
  failureKinds: Object.fromEntries(
    [...new Set(failures.map((failure) => failure.kind))].map((kind) => [
      kind,
      failures.filter((failure) => failure.kind === kind).length,
    ])
  ),
  failures: failures.slice(0, 20),
  grep: { candidatePlans, cases: cases.length, plansWithMatches: grepMatches },
  history: { messages: messages.length, queries: historyQueries },
  integrity,
  trigramSearch: { queries: trigramQueries },
  wasmSqlite: sqlite3.version.libVersion,
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...result, failures: undefined }, null, 2)}\n`);
native.close();
nativeHistory.close();
wasm.close();
rmSync(directory, { force: true, recursive: true });
