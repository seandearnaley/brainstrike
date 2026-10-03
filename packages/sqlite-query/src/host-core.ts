import { decodeRequest, type QueryResponse, type SqliteRows } from './protocol.js';
import { SqliteSandbox } from './sandbox.js';

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
        return { id: request.id, kind: 'grepRows', result: sandbox.grep(request) };
      }
      let result: SqliteRows;
      switch (request.kind) {
        case 'query':
          result = sandbox.query(request.sql, request.values, request.maxRows, request.bindings);
          break;
        case 'describeTable':
          result = sandbox.describeTable(request.table);
          break;
        case 'listTables':
          result = sandbox.listTables();
          break;
      }
      return { id: request.id, kind: 'rows', result };
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
