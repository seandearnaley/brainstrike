import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BUILD_UTILS_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_UTILS_PACKAGE_ROOT = path.resolve(BUILD_UTILS_SRC_ROOT, '..');

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(BUILD_UTILS_PACKAGE_ROOT, relativePath), 'utf8');
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

describe('build-utils architecture boundaries', () => {
  it('does not import shared runtime utilities', () => {
    const packageFiles: [relativePath: string, text: string][] = [
      ['package.json', readPackageFile('package.json')],
      ['tsconfig.json', readPackageFile('tsconfig.json')],
      ['tsup.config.ts', readPackageFile('tsup.config.ts')],
    ];
    const sourceFiles = listFiles(BUILD_UTILS_SRC_ROOT)
      .filter((filePath) => path.basename(filePath) !== 'architecture-boundary.test.ts')
      .map<[relativePath: string, text: string]>((filePath) => [
        path.relative(BUILD_UTILS_PACKAGE_ROOT, filePath),
        readFileSync(filePath, 'utf8'),
      ]);

    const violatingFiles = [...packageFiles, ...sourceFiles]
      .filter(([, text]) => text.includes('@brainstrike/utils'))
      .map(([relativePath]) => relativePath);

    expect(violatingFiles).toEqual([]);
  });
});
