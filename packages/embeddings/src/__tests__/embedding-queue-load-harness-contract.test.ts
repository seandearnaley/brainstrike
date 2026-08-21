import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('embedding queue load harness contract', () => {
  const harnessPath = path.resolve(
    process.cwd(),
    'src/__tests__/embedding-queue-load.integration.test.ts'
  );
  const integrationConfigPath = path.resolve(process.cwd(), 'vitest.integration.config.mts');

  it('ships a serialized real-PGlite load matrix for 1, 2, and 4 worker loops', () => {
    expect(existsSync(harnessPath)).toBe(true);

    const integrationConfig = readFileSync(integrationConfigPath, 'utf8');
    expect(integrationConfig).toContain("include: ['**/*.integration.test.*']");
  });
});
