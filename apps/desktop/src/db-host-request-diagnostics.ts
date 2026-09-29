import type { DbHostRequest } from './db-host-protocol';

/** What a request-timeout log names about the request, without its payload. */
export interface RequestTimeoutDiagnostics {
  readonly liveId?: string;
  readonly paramsCount?: number;
  readonly payloadQueryPreview?: string;
  readonly requestKind: DbHostRequest['kind'];
  readonly sqlPreview?: string;
  readonly transactionId?: string;
}

function createQueryPreview(query: string): string {
  return query.replace(/\s+/g, ' ').slice(0, 240);
}

function getParamsCount(params: readonly unknown[] | undefined): number | undefined {
  return params === undefined ? undefined : params.length;
}

function createParamsCountDiagnostic(params: readonly unknown[] | undefined): {
  readonly paramsCount?: number;
} {
  const paramsCount = getParamsCount(params);
  return paramsCount === undefined ? {} : { paramsCount };
}

export function createRequestTimeoutDiagnostics(request: DbHostRequest): RequestTimeoutDiagnostics {
  switch (request.kind) {
    case 'query':
    case 'exec':
    case 'maintenance:exec':
      return {
        requestKind: request.kind,
        sqlPreview: createQueryPreview(request.sql),
        ...createParamsCountDiagnostic(request.params),
      };
    case 'transaction:query':
    case 'transaction:exec':
      return {
        requestKind: request.kind,
        sqlPreview: createQueryPreview(request.sql),
        transactionId: request.transactionId,
        ...createParamsCountDiagnostic(request.params),
      };
    case 'transaction:commit':
    case 'transaction:rollback':
    case 'transaction:start':
      return {
        requestKind: request.kind,
        transactionId: request.transactionId,
      };
    case 'live:start':
      return {
        payloadQueryPreview: createQueryPreview(request.payload.query),
        requestKind: request.kind,
        ...createParamsCountDiagnostic(request.payload.params),
      };
    case 'live:refresh':
    case 'live:stop':
      return {
        liveId: request.liveId,
        requestKind: request.kind,
      };
    default:
      return { requestKind: request.kind };
  }
}
