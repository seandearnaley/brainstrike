import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readDbSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('db package ownership', () => {
  it('keeps the root public API routed through owned barrels', () => {
    const rootIndex = readDbSource('src/index.ts');

    expect(rootIndex).toContain('./managed-cache/index.js');
    expect(rootIndex).toContain('./migrations/index.js');
    expect(rootIndex).toContain('./queue/index.js');
    expect(rootIndex).toContain('./repositories/index.js');
    expect(rootIndex).toContain('./schema/index.js');
    expect(rootIndex).toContain('./search/index.js');

    expect(rootIndex).not.toContain('./managed-cache/apply-managed-cache-batch.js');
    expect(rootIndex).not.toContain('./queue/job-queue.js');
  });

  it('documents the owned db surfaces and focused local verification commands', () => {
    const readme = readDbSource('README.md');

    expect(readme).toContain('Domain Ownership');
    expect(readme).toContain('queue');
    expect(readme).toContain('migrations');
    expect(readme).toContain('repositories');
    expect(readme).toContain('search');
    expect(readme).toContain('schema');
    expect(readme).toContain('pnpm --filter @brainstrike/db exec vitest run');
  });
});
