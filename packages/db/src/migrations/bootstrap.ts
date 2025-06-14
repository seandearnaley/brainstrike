import type { PGlite } from '@electric-sql/pglite';

export async function migrate(db: PGlite) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS file_records (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
