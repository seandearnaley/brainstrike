import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop embedding renderer E2E fixture surface', () => {
  const splitModuleNames = [
    'database-fixture',
    'electron-app-fixture',
    'embedding-assertions',
    'embedding-host-fixture',
    'filesystem-fixture',
    'log-assertions',
  ] as const;

  it('keeps split responsibility modules present for E2E type-check imports', () => {
    for (const moduleName of splitModuleNames) {
      expect(
        existsSync(join(process.cwd(), 'e2e', 'embedding-worker-renderer', `${moduleName}.ts`))
      ).toBe(true);
    }
  });

  it('keeps the legacy shared barrel anchored to the split Electron app fixture', () => {
    const sharedSource = readFileSync(
      join(process.cwd(), 'e2e', 'embedding-worker-renderer.shared.ts'),
      'utf8'
    );

    expect(sharedSource).toContain("from './embedding-worker-renderer/electron-app-fixture'");
    expect(sharedSource).not.toContain("import net from 'node:net'");
    expect(sharedSource).not.toContain("from './utils/load-electron-helpers'");
  });
});
