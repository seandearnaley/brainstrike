/**
 * Database corruption classification. Node-safe: no Electron imports.
 *
 * The rule is SQLSTATE only: an error is corruption exactly when its `code` is
 * `XX001` (data_corrupted) or `XX002` (index_corrupted). `XX000`
 * (internal_error) stays excluded — it is used for many non-corruption
 * failures. There is no free-text matching of any kind: error messages can echo
 * user input, and Postgres writes routine crash-recovery lines such as
 * "database system was interrupted" during a healthy restart.
 *
 * A wrapper that preserves the original error as its ES2022 `cause` is still
 * classified: the `cause` chain is followed for at most
 * {@link MAX_CAUSE_DEPTH} levels, by SQLSTATE only, and the bound also ends
 * any cyclic chain.
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

const MAX_CAUSE_DEPTH = 5;

function readSignal(fields: Record<string, unknown>): DatabaseCorruptionSignal | null {
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

export function classifyDatabaseCorruption(error: unknown): DatabaseCorruptionSignal | null {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    const fields = current as Record<string, unknown>;
    const signal = readSignal(fields);
    if (signal) {
      return signal;
    }
    current = fields['cause'];
  }
  return null;
}

export function isCorruptionError(error: unknown): boolean {
  return classifyDatabaseCorruption(error) !== null;
}
