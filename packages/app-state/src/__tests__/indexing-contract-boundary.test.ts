// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_STATE_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THIS_TEST_FILE = fileURLToPath(import.meta.url);
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

function findViolations(files: readonly string[], forbiddenImportPattern: RegExp): string[] {
  return files
    .filter((filePath) => forbiddenImportPattern.test(readFileSync(filePath, 'utf8')))
    .map((filePath) => path.relative(APP_STATE_SRC_ROOT, filePath));
}

function collectGuardedSourceFiles(): string[] {
  return collectSourceFiles(APP_STATE_SRC_ROOT).filter((filePath) => filePath !== THIS_TEST_FILE);
}

describe('app-state indexing boundary', () => {
  it('uses indexing contracts for chunking settings instead of text splitter implementation', () => {
    const forbiddenImportPattern =
      /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/text-splitter(?:\/|['"])/;
    const sourceFiles = collectGuardedSourceFiles();

    expect(sourceFiles.length).toBeGreaterThanOrEqual(90);
    expect(findViolations(sourceFiles, forbiddenImportPattern)).toEqual([]);
  });

  it('uses indexing contracts for embedding provider metadata instead of embeddings internals', () => {
    const forbiddenImportPattern =
      /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/embeddings\/provider-core(?:\/|['"])/;
    const sourceFiles = collectGuardedSourceFiles();

    expect(sourceFiles.length).toBeGreaterThanOrEqual(90);
    expect(findViolations(sourceFiles, forbiddenImportPattern)).toEqual([]);
  });

  it('money controls observe both forbidden implementation imports', () => {
    const sourceFiles = collectGuardedSourceFiles();
    const controlFile = sourceFiles[0];
    expect(controlFile).toBeDefined();
    if (!controlFile) {
      throw new Error('Indexing boundary control requires at least one real source file');
    }
    const originalSource = readFileSync(controlFile, 'utf8');
    const syntheticSources = new Map<string, string>([
      [controlFile, `${originalSource}\nimport control from '@brainstrike/text-splitter';\n`],
    ]);
    const findSyntheticViolations = (pattern: RegExp): string[] =>
      sourceFiles
        .filter((filePath) =>
          pattern.test(syntheticSources.get(filePath) ?? readFileSync(filePath, 'utf8'))
        )
        .map((filePath) => path.relative(APP_STATE_SRC_ROOT, filePath));

    expect(
      findSyntheticViolations(
        /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/text-splitter(?:\/|['"])/
      )
    ).toEqual([path.relative(APP_STATE_SRC_ROOT, controlFile)]);

    syntheticSources.set(
      controlFile,
      `${originalSource}\nimport control from '@brainstrike/embeddings/provider-core';\n`
    );
    expect(
      findSyntheticViolations(
        /(?:from\s+['"]|import\s*\(\s*['"])@brainstrike\/embeddings\/provider-core(?:\/|['"])/
      )
    ).toEqual([path.relative(APP_STATE_SRC_ROOT, controlFile)]);
  });
});
