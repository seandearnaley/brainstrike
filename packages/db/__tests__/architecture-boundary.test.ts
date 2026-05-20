import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(DB_PACKAGE_ROOT, relativePath), 'utf8');
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

function readRelativeSourceFiles(relativeRoot: string): [relativePath: string, text: string][] {
  const root = path.join(DB_PACKAGE_ROOT, relativeRoot);
  return listFiles(root)
    .filter((filePath) => path.basename(filePath) !== 'architecture-boundary.test.ts')
    .map((filePath) => [path.relative(DB_PACKAGE_ROOT, filePath), readFileSync(filePath, 'utf8')]);
}

describe('db architecture boundaries', () => {
  it('does not import text-splitter implementation details', () => {
    const packageFiles: [relativePath: string, text: string][] = [
      ['package.json', readPackageFile('package.json')],
      ['tsconfig.json', readPackageFile('tsconfig.json')],
      ['vitest.config.mts', readPackageFile('vitest.config.mts')],
    ];
    const sourceFiles = [
      ...readRelativeSourceFiles('src'),
      ...readRelativeSourceFiles('__tests__'),
    ];

    const violatingFiles = [...packageFiles, ...sourceFiles]
      .filter(([, text]) => text.includes('@brainstrike/text-splitter'))
      .map(([relativePath]) => relativePath);

    expect(violatingFiles).toEqual([]);
  });
});
