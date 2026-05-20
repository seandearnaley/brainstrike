import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const QUEUE_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && SOURCE_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('queue indexing boundary', () => {
  it('depends on indexing contracts instead of embedding worker implementation types', () => {
    const forbiddenImportPattern =
      /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/embedding-worker(?:\/|['"])/;
    const violatingFiles = collectSourceFiles(QUEUE_SRC_ROOT)
      .filter((filePath) => forbiddenImportPattern.test(readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(QUEUE_SRC_ROOT, filePath));

    expect(violatingFiles).toEqual([]);
  });
});
