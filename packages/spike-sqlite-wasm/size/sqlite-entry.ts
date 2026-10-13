// Engine-only size probe: what the web DB worker must load to open a database on opfs-sahpool.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const sqlite3 = await sqlite3InitModule();
const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'size-probe' });
const db = new pool.OpfsSAHPoolDb('/probe.db');
postMessage(db.selectValue('SELECT sqlite_version()'));
