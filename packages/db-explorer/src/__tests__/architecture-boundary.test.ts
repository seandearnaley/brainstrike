// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

describe('db-explorer architecture boundary', () => {
  it('keeps database demo data hook as orchestration over owned helper modules', () => {
    const source = readSource('use-database-demo-data.ts');

    expect(source.split('\n').length).toBeLessThanOrEqual(1500);
    expect(source).toMatch(/database-demo-data-mappers/);
  });
});
