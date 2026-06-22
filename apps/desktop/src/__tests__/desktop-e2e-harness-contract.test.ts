import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readElectronHelpersSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/utils/electron-helpers.mts'), 'utf8');
}

function readElectronFixtureSource(): string {
  return readFileSync(join(process.cwd(), 'e2e/fixtures/electron-fixture.ts'), 'utf8');
}

describe('desktop E2E harness contract', () => {
  it('keeps dev-server launches in Electron test mode', () => {
    const source = readElectronHelpersSource();

    expect(source).toContain("'--test-mode'");
    expect(source).not.toContain("launchMode === 'test-built' ? ['--test-mode'] : []");
  });

  it('removes isolated Electron user-data directories during fixture teardown', () => {
    const source = readElectronFixtureSource();

    expect(source).toContain('removeElectronUserDataDir');
    expect(source).toContain('await removeElectronUserDataDir(userDataDir)');
    expect(source).toContain('Failed to remove Electron userData directory after fixture teardown');
  });
});
