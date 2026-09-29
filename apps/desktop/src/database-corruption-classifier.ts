/**
 * Database corruption classification. Node-safe: no Electron imports.
 *
 * The rule is SQLSTATE only: an error is corruption exactly when its `code` is
 * `XX001` (data_corrupted) or `XX002` (index_corrupted). `XX000`
 * (internal_error) stays excluded — it is used for many non-corruption
 * failures. There is no free-text matching of any kind: error messages can echo
 * user input, and Postgres writes routine crash-recovery lines such as
 * "database system was interrupted" during a healthy restart.
 */

export type DatabaseCorruptionSqlstate = 'XX001' | 'XX002';

/**
 * `message` is the error's own message, or `SQLSTATE <code>` when it carries
 * none. `file`, `routine`, `schema` and `table` are the identifier-only
 * Postgres error fields; row data and SQL text are never copied.
 */
export interface DatabaseCorruptionSignal {
  readonly file?: string;
  readonly message: string;
  readonly routine?: string;
  readonly schema?: string;
  readonly sqlstate: DatabaseCorruptionSqlstate;
  readonly table?: string;
}

function isCorruptionSqlstate(code: unknown): code is DatabaseCorruptionSqlstate {
  return code === 'XX001' || code === 'XX002';
}

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function classifyDatabaseCorruption(error: unknown): DatabaseCorruptionSignal | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const fields = error as Record<string, unknown>;
  const sqlstate = fields['code'];
  if (!isCorruptionSqlstate(sqlstate)) {
    return null;
  }
  const routine = readStringField(fields, 'routine');
  const file = readStringField(fields, 'file');
  const schema = readStringField(fields, 'schema');
  const table = readStringField(fields, 'table');
  return {
    message: readStringField(fields, 'message') ?? `SQLSTATE ${sqlstate}`,
    sqlstate,
    ...(routine === undefined ? {} : { routine }),
    ...(file === undefined ? {} : { file }),
    ...(schema === undefined ? {} : { schema }),
    ...(table === undefined ? {} : { table }),
  };
}

export function isCorruptionError(error: unknown): boolean {
  return classifyDatabaseCorruption(error) !== null;
}
