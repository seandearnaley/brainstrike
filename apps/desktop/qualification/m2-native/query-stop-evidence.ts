export interface IndexQueryStopEvidence {
  readonly code: 'sqlite_query_cancelled';
  readonly ownerPid: number;
  readonly phase: 'query';
  readonly requestId: number;
  readonly requestKind: 'query';
  readonly target: 'index';
}

/** Read ordinary production diagnostics; this creates no query or cancellation seam. */
export function readIndexQueryStopEvidence(
  output: readonly string[],
  ownerPid: number
): IndexQueryStopEvidence | null {
  const records: Record<string, unknown>[] = [];
  for (const line of output.join('').split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record['code'] === 'sqlite_query_cancelled') {
        records.push(record);
      }
    }
  }
  if (records.length === 0) {
    return null;
  }
  if (records.length !== 1) {
    throw new Error('Exactly one owned query cancellation diagnostic is required.');
  }
  const record = records[0];
  if (
    record?.['scope'] !== 'AssistantQuerySelfTool' ||
    record['msg'] !== 'Index self-query cancelled' ||
    record['phase'] !== 'query' ||
    record['ownerPid'] !== ownerPid ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 0 ||
    typeof record['requestId'] !== 'number' ||
    !Number.isSafeInteger(record['requestId']) ||
    record['requestId'] <= 0 ||
    record['requestKind'] !== 'query' ||
    record['target'] !== 'index'
  ) {
    throw new Error(
      'Stop must cancel the executing native query; startup and deadline are unqualified.'
    );
  }
  return {
    code: 'sqlite_query_cancelled',
    ownerPid,
    phase: 'query',
    requestId: record['requestId'],
    requestKind: 'query',
    target: 'index',
  };
}

export function requireIndexQueryStopEvidence(
  output: readonly string[],
  ownerPid: number
): IndexQueryStopEvidence {
  const evidence = readIndexQueryStopEvidence(output, ownerPid);
  if (!evidence) {
    throw new Error('No executing native query cancellation was observed.');
  }
  return evidence;
}
