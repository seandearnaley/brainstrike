import type { QuerySelfInput } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { SqliteQueryClient, SqliteValue } from '@brainstrike/sqlite-query';
import { type QuerySelfResult, shapeQuerySelfRows } from './query-self-tool';

export type QuerySelfIndexClient = Pick<
  SqliteQueryClient,
  'query' | 'listTables' | 'describeTable' | 'close'
>;

function lensBindings(values: readonly unknown[]): Readonly<Record<string, SqliteValue>> {
  return Object.fromEntries(
    values.map((value, index) => {
      if (typeof value === 'boolean') {
        return [`$${index + 1}`, value ? 1 : 0];
      }
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
        return [`$${index + 1}`, value];
      }
      throw new ToolInputError(
        'SQLite lens values must be declared text, finite numbers or booleans.'
      );
    })
  );
}

async function executeIndexQuery(
  input: QuerySelfInput,
  invocation: { params: readonly unknown[]; sql: string } | undefined,
  client: QuerySelfIndexClient
): Promise<QuerySelfResult> {
  const sql = invocation?.sql ?? input.sql?.trim();
  const table = input.table?.trim();
  if (input.mode === 'listTables') {
    const result = await client.listTables();
    const tables = result.rows.map((row) => {
      if (typeof row[0] !== 'string') {
        throw new TypeError('SQLite table listing returned an invalid name.');
      }
      return { estimatedRows: null, name: row[0] };
    });
    return {
      kind: 'tables',
      tables,
      target: 'index',
      ...(result.truncated ? { truncated: true } : {}),
    };
  }
  if (input.mode === 'describeTable' && table) {
    const result = await client.describeTable(table);
    const columns = result.rows.map((row) => {
      if (typeof row[0] !== 'string' || typeof row[1] !== 'string' || typeof row[2] !== 'number') {
        throw new TypeError('SQLite table description returned invalid columns.');
      }
      return { dataType: row[1], name: row[0], nullable: row[2] === 0 };
    });
    return {
      columns,
      kind: 'columns',
      table,
      target: 'index',
      ...(result.truncated ? { truncated: true } : {}),
    };
  }
  if (!sql) {
    throw new ToolInputError('SQLite query requires a statement.');
  }
  if (input.mode === 'explain') {
    const result = await client.query(`EXPLAIN QUERY PLAN ${sql}`, { maxRows: 200 });
    const plan = result.rows.map((row) => row.map(String).join('\t'));
    if (result.truncated) {
      plan.push('More plan rows omitted by the 200-row cap.');
    }
    return { analyzed: false, kind: 'plan', plan, target: 'index' };
  }
  const maxRows = input.maxRows ?? 50;
  const result = await client.query(sql, {
    maxRows,
    ...(invocation ? { bindings: lensBindings(invocation.params) } : {}),
  });
  return shapeQuerySelfRows(result, maxRows, 'index');
}

/** Join the owner on both paths; preserve both failures if cleanup also refuses. */
async function withIndexQueryClient(
  client: QuerySelfIndexClient,
  execute: () => Promise<QuerySelfResult>
): Promise<QuerySelfResult> {
  let result: QuerySelfResult;
  try {
    result = await execute();
  } catch (operationError) {
    try {
      await client.close();
    } catch (cleanup) {
      throw new AggregateError(
        [operationError, cleanup],
        'Index query and owned process cleanup failed.',
        { cause: operationError }
      );
    }
    throw operationError;
  }
  await client.close();
  return result;
}

export async function runIndexQuerySelf(
  input: QuerySelfInput,
  invocation: { params: readonly unknown[]; sql: string } | undefined,
  acquire?: () => Promise<QuerySelfIndexClient>
): Promise<QuerySelfResult> {
  // Validate unsupported operations before acquiring a process.
  if (input.analyze === true) {
    throw new ToolInputError(
      'SQLite index explain uses EXPLAIN QUERY PLAN; analyze=true is unsupported. Use target="app" for PostgreSQL EXPLAIN ANALYZE.'
    );
  }
  if (input.mode === 'describeTable' && !input.table?.trim()) {
    throw new ToolInputError(
      'mode="describeTable" requires a table name. Use mode="listTables" to see them.'
    );
  }
  if (
    ['query', 'lens', 'explain'].includes(input.mode) &&
    !(invocation?.sql ?? input.sql?.trim())
  ) {
    throw new ToolInputError('mode="query" and mode="explain" require a sql statement.');
  }
  const open =
    acquire ??
    (async () => {
      const { openIndexQuery } = await import('../sqlite-query-host-manager');
      return openIndexQuery();
    });
  const client = await open();
  return withIndexQueryClient(client, () => executeIndexQuery(input, invocation, client));
}
