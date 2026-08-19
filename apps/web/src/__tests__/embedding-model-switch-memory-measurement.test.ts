import { describe, expect, it } from 'vitest';
import {
  readExclusiveProbeWorkerMemory,
  readMemoryMeasurement,
} from '../embedding-model-switch-memory-measurement';

const PROBE_URL = 'http://localhost/assets/embedding-model-switch-memory-probe.worker-test.js';

describe('BST-369 worker memory attribution', () => {
  it('counts entries attributed exclusively to the probe worker', () => {
    const measurement = readMemoryMeasurement({
      breakdown: [
        {
          attribution: [{ scope: 'DedicatedWorkerGlobalScope', url: PROBE_URL }],
          bytes: 41_943_040,
        },
        {
          attribution: [{ scope: 'Window', url: 'http://localhost/' }],
          bytes: 200_000_000,
        },
      ],
      bytes: 241_943_040,
    });

    expect(readExclusiveProbeWorkerMemory(measurement)).toEqual({
      workerBreakdownCount: 1,
      workerBytes: 41_943_040,
      workerUrls: [PROBE_URL],
    });
  });

  it('rejects mixed page and probe-worker attribution', () => {
    const measurement = readMemoryMeasurement({
      breakdown: [
        {
          attribution: [
            { scope: 'DedicatedWorkerGlobalScope', url: PROBE_URL },
            { scope: 'Window', url: 'http://localhost/' },
          ],
          bytes: 241_943_040,
        },
      ],
      bytes: 241_943_040,
    });

    expect(() => readExclusiveProbeWorkerMemory(measurement)).toThrow(
      'BST-369 cannot isolate probe worker bytes from a mixed-attribution memory entry.'
    );
  });

  it('ignores other dedicated workers instead of relabeling their bytes', () => {
    const measurement = readMemoryMeasurement({
      breakdown: [
        {
          attribution: [
            {
              scope: 'DedicatedWorkerGlobalScope',
              url: 'http://localhost/assets/database.worker.js',
            },
          ],
          bytes: 90_000_000,
        },
      ],
      bytes: 90_000_000,
    });

    expect(readExclusiveProbeWorkerMemory(measurement)).toEqual({
      workerBreakdownCount: 0,
      workerBytes: 0,
      workerUrls: [],
    });
  });
});
