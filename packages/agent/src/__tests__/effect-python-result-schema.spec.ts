import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { RunPythonResultSchema } from '../tools/run-python-tool';

const streams = { stderr: '', stderrOmittedBytes: 0, stdout: 'result', stdoutOmittedBytes: 0 };
const valid = [
  { ...streams, exitCode: 0, kind: 'completed' },
  { ...streams, kind: 'timed_out', signal: null, timeoutMs: 100 },
  { ...streams, kind: 'killed', signal: 'SIGTERM' },
  {
    kind: 'cancelled',
    partialStderr: '',
    partialStdout: 'partial',
    processStarted: true,
    stderrOmittedBytes: 0,
    stdoutOmittedBytes: 3,
  },
  { deniedDomains: ['example.com'], kind: 'network_denied' },
  { kind: 'declined' },
  { detail: 'Unavailable', kind: 'unavailable', reason: 'sandbox_readiness_failed' },
];
it.each(valid)('validates the actual $kind result and its cleanup note', async (value) => {
  const noted = { ...value, scratchCleanupFailed: true, scratchDir: '/disposable/scratch' };
  expect(Schema.decodeUnknownSync(RunPythonResultSchema)(noted)).toEqual(noted);
});
it.each([
  {},
  { exitCode: 0, kind: 'completed' },
  { kind: 'cancelled', ...streams },
  { detail: 'x', kind: 'unavailable', reason: 'unknown' },
  { ...streams, exitCode: Number.NaN, kind: 'completed' },
])('rejects malformed output instead of using an unchecked type marker', (value) => {
  expect(Schema.is(RunPythonResultSchema)(value)).toBe(false);
});
