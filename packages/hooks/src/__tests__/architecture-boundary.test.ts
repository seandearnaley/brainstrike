import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOKS_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_PACKAGE_ROOT = path.resolve(HOOKS_SRC_ROOT, '..');

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(HOOKS_PACKAGE_ROOT, relativePath), 'utf8');
}

function listFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listFiles(fullPath));
      continue;
    }
    if (/\.(?:ts|tsx|mts)$/.test(entry)) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('hooks architecture boundaries', () => {
  it('does not import worker implementations directly', () => {
    const packageFiles: [relativePath: string, text: string][] = [
      ['package.json', readPackageFile('package.json')],
      ['tsconfig.json', readPackageFile('tsconfig.json')],
    ];
    const sourceFiles = listFiles(HOOKS_SRC_ROOT)
      .filter((filePath) => path.basename(filePath) !== 'architecture-boundary.test.ts')
      .map<[relativePath: string, text: string]>((filePath) => [
        path.relative(HOOKS_PACKAGE_ROOT, filePath),
        readFileSync(filePath, 'utf8'),
      ]);

    const violatingFiles = [...packageFiles, ...sourceFiles]
      .filter(([, text]) => text.includes('@brainstrike/workers'))
      .map(([relativePath]) => relativePath);

    expect(violatingFiles).toEqual([]);
  });
});
