import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectTypeScriptFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

describe('JSON import attributes', () => {
  it('uses explicit JSON import attributes for Node/Electron ESM compatibility', () => {
    const sourceRoot = path.resolve(import.meta.dirname, '..', 'src');
    expect(statSync(sourceRoot).isDirectory()).toBe(true);

    const missingAttributes = collectTypeScriptFiles(sourceRoot).flatMap((filePath) => {
      const source = readFileSync(filePath, 'utf8');
      const imports = source.matchAll(
        /import\s+[^;]*?from\s+['"][^'"]+\.json['"](?<attribute>\s+with\s+\{\s*type:\s*['"]json['"]\s*\})?\s*;/gsu
      );

      return Array.from(imports)
        .filter((match) => !match.groups?.['attribute'])
        .map(() => path.relative(sourceRoot, filePath));
    });

    expect(missingAttributes).toEqual([]);
  });
});
