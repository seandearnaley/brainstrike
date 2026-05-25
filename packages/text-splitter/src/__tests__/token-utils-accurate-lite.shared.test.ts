import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sharedRuntimePath = resolve(
  repoRoot,
  'packages/text-splitter/src/token-utils-accurate-lite.ts'
);
const workerShimPaths = [
  resolve(repoRoot, 'packages/chunking-worker/src/token-utils-accurate-lite.ts'),
  resolve(repoRoot, 'packages/token-cache/src/token-utils-accurate-lite.ts'),
];

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('token-utils-accurate-lite shared source', () => {
  it('keeps the accurate tiktoken runtime single-sourced in text-splitter', () => {
    expect(existsSync(sharedRuntimePath)).toBe(true);

    for (const shimPath of workerShimPaths) {
      const source = readSource(shimPath);
      const nonEmptyLines = source.split(/\r?\n/).filter((line) => line.trim().length > 0);

      expect(source).toContain("from '@brainstrike/text-splitter/token-utils-accurate-lite'");
      expect(source).not.toContain("import('tiktoken')");
      expect(source).not.toContain('import(/* @vite-ignore */ NODE_TIKTOKEN_SPECIFIER)');
      expect(source).not.toContain('tiktoken/lite/init');
      expect(nonEmptyLines.length).toBeLessThanOrEqual(8);
    }
  });
});
