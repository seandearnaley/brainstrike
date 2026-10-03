import { serialize } from 'node:v8';
import { decodeRequest, type QueryResponse, type SqliteRows } from './protocol.js';
import { SqliteSandbox } from './sandbox.js';

function boundedResponse(response: QueryResponse): QueryResponse {
  // Retain the sandbox's incremental row guard and include all metadata/envelope bytes here.
  if (serialize(response).byteLength > 1024 * 1024) {
    throw new RangeError(
      'Query response exceeds the 1 MiB process-message budget. Refine the query or rebuild oversized index metadata.'
    );
  }
  return response;
}

export function createQueryHost(
  send: (response: QueryResponse) => void
): (message: unknown) => void {
  let sandbox: SqliteSandbox | undefined;

  function dispatch(message: unknown): QueryResponse {
    const request = decodeRequest(message);
    try {
      if (request.kind === 'open') {
        if (sandbox) {
          throw new Error('SQLite query process is already initialized.');
        }
        sandbox = new SqliteSandbox(request.databasePath);
        return { id: request.id, kind: 'ready' };
      }
      if (!sandbox) {
        throw new Error('SQLite query process has not been initialized.');
      }
      if (request.kind === 'grep') {
        return boundedResponse({ id: request.id, kind: 'grepRows', result: sandbox.grep(request) });
      }
      let result: SqliteRows;
      switch (request.kind) {
        case 'query':
          result = sandbox.query(
            request.sql,
            request.values,
            request.maxRows,
            request.bindings,
            request.requirement
          );
          break;
        case 'describeTable':
          result = sandbox.describeTable(request.table);
          break;
        case 'listTables':
          result = sandbox.listTables();
          break;
      }
      return boundedResponse({ id: request.id, kind: 'rows', result });
    } catch (error) {
      return {
        id: request.id,
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
      };
    }
  }

  return (message: unknown): void => {
    try {
      send(dispatch(message));
    } catch {
      // A malformed parent protocol cannot be correlated safely.
      sandbox?.close();
      process.exit(1);
    }
  };
}
