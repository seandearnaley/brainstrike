import { serialize } from 'node:v8';
import {
  assertCoverageAuthorityBound,
  type CoverageAuthority,
  fault,
  readNativeCoverage,
} from '@brainstrike/indexer/coverage-reader';
import { ErrorCodes, type MessageConnection, ResponseError } from 'vscode-jsonrpc/node';
import { type QueryErrorData, queryMethods } from './protocol.ts';
import { SqliteSandbox } from './sandbox.ts';

const RESPONSE_BUDGET_BYTES = 1024 * 1024;

function bounded<T>(result: T): T {
  // Retain the sandbox's incremental row guard and include the reply envelope's bytes here.
  if (
    serialize({ id: Number.MAX_SAFE_INTEGER, jsonrpc: '2.0', result }).byteLength >
    RESPONSE_BUDGET_BYTES
  ) {
    throw new RangeError(
      'Query response exceeds the 1 MiB process-message budget. Refine the query or rebuild oversized index metadata.'
    );
  }
  return result;
}

function refused(error: unknown, data: QueryErrorData): ResponseError<QueryErrorData> {
  return new ResponseError(
    ErrorCodes.InternalError,
    error instanceof Error ? error.message : String(error),
    data
  );
}

const engine = (error: unknown): ResponseError<QueryErrorData> =>
  refused(error, { kind: 'engine', name: error instanceof Error ? error.name : 'Error' });
const coverage = (error: unknown): ResponseError<QueryErrorData> =>
  refused(error, { fault: fault(error), kind: 'coverage' });

/**
 * Serve one read-only owner on `connection`: `open` (a grep sandbox) or `openNativeCoverage`
 * (the trusted coverage-only owner), once, then its reads. Params that do not decode are a
 * protocol fault the vendor answers, and the client stops this process for it.
 */
export function serveQueryHost(connection: MessageConnection): void {
  let sandbox: SqliteSandbox | undefined;
  let coverageAuthority: CoverageAuthority | undefined;
  const handle = <T>(
    work: () => T,
    classify: (error: unknown) => ResponseError<QueryErrorData>
  ): T | ResponseError<QueryErrorData> => {
    try {
      return work();
    } catch (error) {
      return classify(error);
    }
  };
  connection.onRequest('open', (input: unknown) => {
    const { databasePath } = queryMethods.open.params(input);
    return handle(() => {
      if (sandbox || coverageAuthority) {
        throw new Error('SQLite query process is already initialized.');
      }
      sandbox = new SqliteSandbox(databasePath);
      return null;
    }, engine);
  });
  connection.onRequest('openNativeCoverage', (input: unknown) => {
    const request = queryMethods.openNativeCoverage.params(input);
    return handle(() => {
      assertCoverageAuthorityBound(request);
      if (sandbox || coverageAuthority) {
        throw new Error('SQLite query process is already initialized.');
      }
      coverageAuthority = request.authority;
      return null;
    }, coverage);
  });
  connection.onRequest('grep', (input: unknown) => {
    const request = queryMethods.grep.params(input);
    return handle(() => {
      if (!sandbox) {
        throw new Error('SQLite query process has not been initialized.');
      }
      return bounded(sandbox.grep(request));
    }, engine);
  });
  connection.onRequest('nativeCoverage', (input: unknown) => {
    const { requests } = queryMethods.nativeCoverage.params(input);
    return handle(() => {
      if (!coverageAuthority) {
        throw new Error('Native coverage requires its trusted coverage-only owner.');
      }
      return bounded(readNativeCoverage(coverageAuthority, requests));
    }, coverage);
  });
  connection.onClose(() => {
    sandbox?.close();
  });
}
