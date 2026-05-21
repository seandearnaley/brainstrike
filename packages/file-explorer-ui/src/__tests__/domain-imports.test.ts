import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    if (entry === '__tests__') {
      continue;
    }

    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath));
      continue;
    }

    if (stats.isFile() && /\.(?:ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }

  return files;
}

describe('file-explorer-ui domain imports', () => {
  it('keeps package internals off the root package barrel', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const offenders = collectSourceFiles(sourceRoot)
      .filter((filePath) =>
        readFileSync(filePath, 'utf8').includes('@brainstrike/file-explorer-ui')
      )
      .map((filePath) => path.relative(sourceRoot, filePath));

    expect(offenders).toEqual([]);
  });
});
