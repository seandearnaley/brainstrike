import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readIndexQueryStopEvidence,
  requireIndexQueryStopEvidence,
} from './query-stop-evidence.ts';

const diagnostic = {
  code: 'sqlite_query_cancelled',
  msg: 'Index self-query cancelled',
  ownerPid: 42,
  phase: 'query',
  requestId: 2,
  requestKind: 'query',
  scope: 'AssistantQuerySelfTool',
  target: 'index',
};
const output = (record) => [`${JSON.stringify(record)}\n`];

test('requires the real query phase and request rather than startup or another operation', () => {
  for (const change of [
    { phase: 'startup' },
    { requestId: 0 },
    { requestId: '2' },
    { ownerPid: 43 },
    { requestKind: 'listTables' },
    { scope: 'Unrelated' },
    { target: 'app' },
    { msg: 'Unrelated' },
  ]) {
    assert.throws(() => requireIndexQueryStopEvidence(output({ ...diagnostic, ...change }), 42));
  }
});

test('rejects a deadline, absent observation and multiple uncorrelated cancellations', () => {
  assert.throws(() =>
    requireIndexQueryStopEvidence(output({ code: 'SqliteQueryDeadlineError' }), 42)
  );
  assert.throws(() => requireIndexQueryStopEvidence([], 42));
  assert.throws(() =>
    requireIndexQueryStopEvidence([...output(diagnostic), ...output(diagnostic)], 42)
  );
});

test('reads split stdout chunks with ordinary non-JSON process output', () => {
  const raw = `ordinary process line\n${JSON.stringify(diagnostic)}\n`;
  assert.equal(readIndexQueryStopEvidence([raw.slice(0, 65)], 42), null);
  assert.deepEqual(requireIndexQueryStopEvidence([raw.slice(0, 65), raw.slice(65)], 42), {
    code: 'sqlite_query_cancelled',
    ownerPid: 42,
    phase: 'query',
    requestId: 2,
    requestKind: 'query',
    target: 'index',
  });
});

test('retains the actual positive request sequence and rejects a missing owned PID', () => {
  assert.equal(
    requireIndexQueryStopEvidence(output({ ...diagnostic, requestId: 7 }), 42).requestId,
    7
  );
  const { ownerPid, ...missingPid } = diagnostic;
  assert.throws(() => requireIndexQueryStopEvidence(output(missingPid), ownerPid));
});
