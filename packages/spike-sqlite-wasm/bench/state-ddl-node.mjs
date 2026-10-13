// BST-1940 spike: the desktop state.db upgrader (UPGRADES v1..v6, unchanged) on the sqlite-wasm build
// (in-memory, same sqlite3.wasm), compared object by object with what desktop created.
import { readFileSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { SCHEMA_VERSION, UPGRADES } from '../../state-store/src/schema.mjs';
import { diffSchema, migrateState, readSchema } from '../src/desktop-ddl.mjs';

const schema = JSON.parse(
  readFileSync(new URL('../src/desktop-schema.json', import.meta.url), 'utf8')
);
const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(':memory:', 'c');
let error;
try {
  migrateState(db, UPGRADES, SCHEMA_VERSION);
} catch (caught) {
  error = String(caught.message ?? caught);
}
process.stdout.write(
  `${JSON.stringify(
    {
      diff: diffSchema(schema.state.objects, readSchema(db)),
      error,
      objects: readSchema(db).length,
      userVersion: db.selectValue('PRAGMA user_version'),
    },
    null,
    2
  )}\n`
);
