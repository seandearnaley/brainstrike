import { serialize } from 'node:v8';
import {
  assertCoverageAuthorityBound,
  type CoverageAuthority,
  fault,
  readNativeCoverage,
} from '@brainstrike/indexer/coverage-reader';
import { decodeRequest, type QueryRequest, type QueryResponse } from './protocol.js';
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
  let coverageAuthority: CoverageAuthority | undefined;

  function dispatchCoverage(
    request: Extract<QueryRequest, { kind: 'open-native-coverage' | 'native-coverage' }>
  ): QueryResponse {
    if (request.kind === 'open-native-coverage') {
      assertCoverageAuthorityBound(request);
      if (sandbox || coverageAuthority) {
        throw new Error('SQLite query process is already initialized.');
      }
      coverageAuthority = request.authority;
      return { id: request.id, kind: 'ready' };
    }
    if (request.kind === 'native-coverage') {
      if (!coverageAuthority) {
        throw new Error('Native coverage requires its trusted coverage-only owner.');
      }
      return boundedResponse({
        id: request.id,
        kind: 'nativeCoverage',
        result: readNativeCoverage(coverageAuthority, request.requests),
      });
    }
    throw new Error('Unsupported native coverage operation.');
  }
  function dispatchGrep(
    request: Exclude<QueryRequest, { kind: 'open-native-coverage' | 'native-coverage' }>
  ): QueryResponse {
    if (request.kind === 'open') {
      if (sandbox || coverageAuthority) {
        throw new Error('SQLite query process is already initialized.');
      }
      sandbox = new SqliteSandbox(request.databasePath);
      return { id: request.id, kind: 'ready' };
    }
    if (!sandbox) {
      throw new Error('SQLite query process has not been initialized.');
    }
    return boundedResponse({ id: request.id, kind: 'grepRows', result: sandbox.grep(request) });
  }
  function dispatch(message: unknown): QueryResponse {
    const request = decodeRequest(message);
    try {
      if (request.kind === 'open-native-coverage' || request.kind === 'native-coverage') {
        return dispatchCoverage(request);
      }
      return dispatchGrep(request);
    } catch (error) {
      if (request.kind === 'native-coverage' || request.kind === 'open-native-coverage') {
        return { error: fault(error), id: request.id, kind: 'nativeCoverageError' };
      }
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
