// @ts-check
// BST-1940 spike: apply the desktop schema to a sqlite-wasm oo1 DB, unchanged.
// - state.db: the desktop upgrader itself (UPGRADES[v-1] per version, one transaction each, user_version).
// - derived index: the object list desktop created (bench/dump-desktop-schema.mjs), replayed in creation order.
// Every statement's outcome is recorded; nothing is rewritten to make it pass.

/**
 * Port of packages/state-store/src/schema.mjs migrate() to the oo1 API (same SQL, same transaction shape).
 * @param {any} db sqlite-wasm oo1 DB
 * @param {readonly string[]} upgrades
 * @param {number} version
 * @returns {{ from: number, to: number }}
 */
export function migrateState(db, upgrades, version) {
  const current = Number(db.selectValue('PRAGMA user_version'));
  if (current > version) {
    throw new Error(
      `state.db schema version ${current} is newer than this build supports (${version})`
    );
  }
  for (let next = current + 1; next <= version; next++) {
    const sql = upgrades[next - 1];
    if (sql === undefined) {
      throw new Error(`no schema upgrade to version ${next}`);
    }
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${next}`);
    });
  }
  return { from: current, to: version };
}

/**
 * @typedef {{ type: string, name: string, tableName: string, sql: string, shadow: boolean }} SchemaObject
 * @typedef {{ name: string, type: string, outcome: 'ok' | 'error' | 'skipped', detail?: string }} Outcome
 */

/**
 * Replays desktop-created objects in creation order inside one transaction.
 * FTS5 shadow tables are created by their virtual table, so they are not replayed. A virtual table whose
 * module is missing has its module-created tables skipped (they would otherwise be created as plain tables).
 * @param {any} db
 * @param {readonly SchemaObject[]} objects
 * @returns {Outcome[]}
 */
export function replayObjects(db, objects) {
  /** @type {Outcome[]} */
  const outcomes = [];
  /** @type {string[]} */
  const failedModules = [];
  db.transaction(() => {
    for (const object of objects) {
      if (object.shadow) {
        outcomes.push({
          detail: 'created by its virtual table',
          name: object.name,
          outcome: 'skipped',
          type: object.type,
        });
        continue;
      }
      const parent = failedModules.find((name) => object.name.startsWith(`${name}_`));
      if (parent) {
        outcomes.push({
          detail: `module table of ${parent}, whose module is missing`,
          name: object.name,
          outcome: 'skipped',
          type: object.type,
        });
        continue;
      }
      try {
        db.exec(object.sql);
        outcomes.push({ name: object.name, outcome: 'ok', type: object.type });
      } catch (error) {
        if (/^CREATE VIRTUAL TABLE/i.test(object.sql)) {
          failedModules.push(object.name);
        }
        outcomes.push({
          detail: error instanceof Error ? error.message : String(error),
          name: object.name,
          outcome: 'error',
          type: object.type,
        });
      }
    }
  });
  return outcomes;
}

/**
 * Re-applies desktop FTS5 options (stored in each table's _config shadow, not in sqlite_schema).
 * @param {any} db
 * @param {readonly { table: string, key: string, value: unknown }[]} config
 * @returns {Outcome[]}
 */
export function applyFtsConfig(db, config) {
  return config.map(({ key, table, value }) => {
    try {
      // Literal SQL, as desktop issues it: FTS5 rejects a REAL-bound 1.0 for integer options.
      const literal =
        typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
      db.exec(
        `INSERT INTO "${table}"("${table}",rank) VALUES('${key.replaceAll("'", "''")}',${literal})`
      );
      return {
        detail: `${key}=${String(value)}`,
        name: table,
        outcome: /** @type {const} */ ('ok'),
        type: 'fts5-config',
      };
    } catch (error) {
      return {
        detail: error instanceof Error ? error.message : String(error),
        name: table,
        outcome: /** @type {const} */ ('error'),
        type: 'fts5-config',
      };
    }
  });
}

/**
 * The schema as sqlite_schema records it, in the same projection the dump used.
 * @param {any} db
 * @returns {{ type: string, name: string, tableName: string, sql: string }[]}
 */
export function readSchema(db) {
  return db.selectObjects(
    "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
  );
}

/**
 * Objects that differ between the desktop dump and the wasm DB (by name; sql compared byte for byte).
 * @param {readonly SchemaObject[]} desktop
 * @param {readonly { name: string, sql: string }[]} wasm
 */
export function diffSchema(desktop, wasm) {
  const byName = new Map(wasm.map((object) => [object.name, object.sql]));
  const missing = desktop.filter((object) => !byName.has(object.name)).map((object) => object.name);
  const changed = desktop
    .filter((object) => byName.has(object.name) && byName.get(object.name) !== object.sql)
    .map((object) => object.name);
  const desktopNames = new Set(desktop.map((object) => object.name));
  const extra = wasm
    .filter((object) => !desktopNames.has(object.name))
    .map((object) => object.name);
  return { changed, extra, missing };
}
