// BST-1940 spike: can the unchanged scoped_vectors DDL work on wasm if web registers a JS vec_length
// (float32 element count, the only blob shape scoped_vectors stores)? vec0 itself stays unavailable.
import { readFileSync } from 'node:fs';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { replayObjects } from '../src/desktop-ddl.mjs';

const schema = JSON.parse(
  readFileSync(new URL('../src/desktop-schema.json', import.meta.url), 'utf8')
);
const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(':memory:', 'c');
db.createFunction({
  arity: 1,
  deterministic: true,
  name: 'vec_length',
  xFunc: (_context, blob) => {
    if (!(blob instanceof Uint8Array) || blob.byteLength % 4 !== 0) {
      throw new Error('float32 vector expected');
    }
    return blob.byteLength / 4;
  },
});
const errors = replayObjects(db, schema.index.objects).filter(
  (outcome) => outcome.outcome === 'error'
);
db.exec(
  "INSERT INTO file_records(id,root_id,name,path,content_hash,snapshot_hash) VALUES('f','r','n','p','c','s')"
);
db.exec(
  "INSERT INTO file_chunks(id,root_id,file_record_id,start_line,end_line,content,content_hash,has_vector) VALUES('c','r','f',1,1,'x','h',0)"
);
db.exec("INSERT INTO vector_profiles VALUES('p','{}',2)");
db.exec({
  bind: [new Uint8Array(new Float32Array([0.5, 0.25]).buffer)],
  sql: "INSERT INTO scoped_vectors(chunk_pk,profile_hash,content_hash,dimensions,emb) VALUES(1,'p','h',2,?)",
});
let mismatched = 'accepted';
try {
  db.exec({
    bind: [new Uint8Array(8)],
    sql: "INSERT INTO scoped_vectors(chunk_pk,profile_hash,content_hash,dimensions,emb) VALUES(1,'p','h',3,?)",
  });
} catch (error) {
  mismatched = `rejected: ${error.message}`;
}
process.stdout.write(
  `${JSON.stringify({
    errors: errors.map((outcome) => `${outcome.name}: ${outcome.detail}`),
    mismatched,
    valid: db.selectValue('SELECT count(*) FROM scoped_vectors'),
  })}\n`
);
