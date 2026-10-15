// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src'
);

const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function formatRelativePath(filePath: string): string {
  return path.relative(PACKAGE_SRC_ROOT, filePath);
}

describe('assistant UI package boundary', () => {
  it('depends on the assistant contract, not the agent runtime package', () => {
    expect(statSync(PACKAGE_SRC_ROOT).isDirectory()).toBe(true);

    const forbiddenImportPattern =
      /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/agent(?:\/|['"])/;
    const violatingFiles = collectSourceFiles(PACKAGE_SRC_ROOT)
      .filter((filePath) => forbiddenImportPattern.test(readFileSync(filePath, 'utf8')))
      .map(formatRelativePath);

    expect(violatingFiles).toEqual([]);
  });
});
