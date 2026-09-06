import { describe, expect, it } from 'vitest';
import { narrowRunPythonDisplayResult } from '../run-python-result-model';

const streams = {
  stderr: '',
  stderrOmittedBytes: 0,
  stdout: '',
  stdoutOmittedBytes: 0,
};

describe('narrowRunPythonDisplayResult numeric fields', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects an invalid completed exit code (%s)',
    (exitCode) => {
      expect(narrowRunPythonDisplayResult({ ...streams, exitCode, kind: 'completed' })).toBeNull();
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects an invalid omitted-byte count (%s)',
    (stdoutOmittedBytes) => {
      expect(
        narrowRunPythonDisplayResult({
          ...streams,
          kind: 'killed',
          signal: null,
          stdoutOmittedBytes,
        })
      ).toBeNull();
    }
  );

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects an invalid timeout duration (%s)',
    (timeoutMs) => {
      expect(
        narrowRunPythonDisplayResult({
          ...streams,
          kind: 'timed_out',
          signal: null,
          timeoutMs,
        })
      ).toBeNull();
    }
  );
});
