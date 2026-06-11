import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop embedding renderer E2E fixture surface', () => {
  const placeholderModuleNames = [
    'database-fixture',
    'embedding-assertions',
    'embedding-host-fixture',
    'filesystem-fixture',
    'log-assertions',
  ] as const;

  it('keeps the moved Electron app helper implementation in its own module', () => {
    expect(
      existsSync(join(process.cwd(), 'e2e', 'embedding-worker-renderer', 'electron-app-fixture.ts'))
    ).toBe(true);
  });

  it('does not keep placeholder split modules without moved implementations', () => {
    for (const moduleName of placeholderModuleNames) {
      expect(
        existsSync(join(process.cwd(), 'e2e', 'embedding-worker-renderer', `${moduleName}.ts`))
      ).toBe(false);
    }
  });
});
