import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const UI_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_PACKAGE_ROOT = path.resolve(UI_SRC_ROOT, '..');

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(UI_PACKAGE_ROOT, relativePath), 'utf8');
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

describe('ui architecture boundaries', () => {
  // Shared-foundation @brainstrike/storage (safe JSON / Zustand helpers) is allowed.
  // The Electron-only subpath must stay out of renderer UI — that was the original
  // architecture-reset invariant (theme/provider must not pull main-process adapters).
  it('does not import Electron storage adapters', () => {
    const packageFiles: [relativePath: string, text: string][] = [
      ['package.json', readPackageFile('package.json')],
      ['tsconfig.json', readPackageFile('tsconfig.json')],
    ];
    const sourceFiles = listFiles(UI_SRC_ROOT)
      .filter((filePath) => path.basename(filePath) !== 'architecture-boundary.test.ts')
      .map<[relativePath: string, text: string]>((filePath) => [
        path.relative(UI_PACKAGE_ROOT, filePath),
        readFileSync(filePath, 'utf8'),
      ]);

    const violatingFiles = [...packageFiles, ...sourceFiles]
      .filter(([, text]) => text.includes('@brainstrike/storage/electron'))
      .map(([relativePath]) => relativePath);

    expect(violatingFiles).toEqual([]);
  });
});
