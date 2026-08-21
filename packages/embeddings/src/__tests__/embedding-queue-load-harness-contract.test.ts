import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedding queue load harness contract', () => {
  const harnessPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-queue-load.integration.test.ts'
  );

  it('ships a serialized real-PGlite load matrix for 1, 2, and 4 worker loops', () => {
    expect(existsSync(harnessPath)).toBe(true);

    const source = readFileSync(harnessPath, 'utf8');
    expect(source).toContain('concurrencyLevels = [1, 2, 4]');
    expect(source).toContain('peakClaimedJobs');
    expect(source).toContain('peakInputBytesInFlight');
    expect(source).toContain('leaseClaimCount');
    expect(source).toContain('completionLatencyMs');
    expect(source).toContain('adaptiveClaimLimits');
  });
});
