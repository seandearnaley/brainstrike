import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const DIRECT_REGISTRY_CHANNEL_PATTERN =
  /registry\.register(?:Invoke|Event)\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]/g;

function listProductionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist') {
        continue;
      }
      files.push(...listProductionTypeScriptFiles(absolutePath));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('desktop IPC channel contract', () => {
  it('keeps production registry channel names behind named contracts', () => {
    const violations: string[] = [];

    for (const filePath of listProductionTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('registry.register')) {
        continue;
      }
      for (const match of source.matchAll(DIRECT_REGISTRY_CHANNEL_PATTERN)) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(SOURCE_ROOT, filePath)}:${lineNumber}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
