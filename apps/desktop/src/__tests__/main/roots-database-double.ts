import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';

interface RootRow {
  readonly id: string;
  readonly path: string;
  status: 'disconnected' | 'live';
}

/**
 * The `roots` table as Main's root registry writes it (BST-1990), for unit tests
 * that run the filesystem composition without PGlite. It answers the registry's
 * statements in the real row shape and refuses any other, so a new statement
 * fails here instead of passing unmodelled.
 */
export function createRootsDatabaseDouble(): WorkspaceRootsQueryable & {
  readonly rows: readonly RootRow[];
} {
  const rows: RootRow[] = [];
  const query = async <T>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement === 'SELECT id, path FROM roots WHERE path IS NOT NULL') {
      return { rows: rows.map(({ id, path }) => ({ id, path }) as T) };
    }
    if (statement.startsWith('SELECT id FROM roots WHERE path = $1')) {
      return { rows: rows.filter((row) => row.path === params[0]).map(({ id }) => ({ id }) as T) };
    }
    if (statement.startsWith('INSERT INTO roots')) {
      rows.push({ id: String(params[0]), path: String(params[2]), status: 'live' });
      return { rows: [] };
    }
    if (statement.startsWith("UPDATE roots SET status = 'live'")) {
      for (const row of rows) {
        if (row.id === params[0] && row.status === 'disconnected') {
          row.status = 'live';
        }
      }
      return { rows: [] };
    }
    if (statement.startsWith("UPDATE roots SET status = 'disconnected'")) {
      const mounted = params[0] as readonly string[];
      const changed = rows.filter((row) => row.status === 'live' && !mounted.includes(row.path));
      for (const row of changed) {
        row.status = 'disconnected';
      }
      return { rows: changed.map(({ id, path }) => ({ id, path }) as T) };
    }
    throw new Error(`The roots database double does not model this statement: ${statement}`);
  };
  return { query, rows };
}
