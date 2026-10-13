// BST-1940 spike: identity and compile options of the official sqlite-wasm build, run on the
// same sqlite3.wasm binary the browser loads (node.mjs and index.mjs both load dist/sqlite3.wasm).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(':memory:', 'c');
const options = db.selectValues('PRAGMA compile_options');
const probe = (sql) => {
  try {
    db.exec(sql);
    return 'ok';
  } catch (error) {
    return String(error.message ?? error);
  }
};
process.stdout.write(
  `${JSON.stringify(
    {
      compileOptions: options,
      features: {
        fts5Porter: probe(
          "CREATE VIRTUAL TABLE p USING fts5(c, tokenize='porter unicode61'); DROP TABLE p;"
        ),
        fts5Trigram: probe(
          "CREATE VIRTUAL TABLE t USING fts5(c, tokenize='trigram'); DROP TABLE t;"
        ),
        jsonEach: probe("SELECT value FROM json_each('[1,2]')"),
        loadExtension: probe("SELECT load_extension('vec0')"),
        strict: probe('CREATE TABLE s(a INTEGER) STRICT; DROP TABLE s;'),
        vec0: probe('CREATE VIRTUAL TABLE v USING vec0(id INTEGER PRIMARY KEY, bin BIT[8])'),
      },
      libVersion: sqlite3.version.libVersion,
      sourceId: sqlite3.version.sourceId,
      wasmSha256: createHash('sha256').update(readFileSync(wasmPath)).digest('hex'),
    },
    null,
    2
  )}\n`
);
db.close();
