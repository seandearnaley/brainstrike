import { existsSync, readFileSync } from 'node:fs';
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

  it('keeps the valid backfill fixture aligned with the durable hash payload contract', () => {
    const source = readFileSync(
      join(process.cwd(), 'e2e', 'embedding-worker-renderer.shared.ts'),
      'utf8'
    );
    const validJobFixture = source
      .split('export async function createTestBackfillJob')[1]
      ?.split('export async function createInvalidJob')[0];

    expect(validJobFixture).toContain('crypto.subtle.digest(');
    expect(validJobFixture).toContain("'SHA-256'");
    expect(validJobFixture).toContain('embeddingInputHash,');
    expect(validJobFixture).toContain('sourceContentHash: contentHash,');
  });
});
