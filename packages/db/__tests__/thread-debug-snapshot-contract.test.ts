import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('thread debug snapshot privacy contract', () => {
  it('requires every exported relation to retain an explicit column allowlist', () => {
    const source = readFileSync(
      new URL('../src/repositories/thread-debug-snapshot.ts', import.meta.url),
      'utf8'
    );
    const inventory = source.slice(
      source.indexOf('const SECTIONS ='),
      source.indexOf('} as const;')
    );
    expect(inventory).not.toMatch(/SELECT\s+\w+\.\*/i);
  });
});
