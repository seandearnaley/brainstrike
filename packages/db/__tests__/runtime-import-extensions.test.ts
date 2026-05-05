import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../src');
const ALLOWED_RUNTIME_EXTENSIONS = ['.js', '.json', '.node'] as const;

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(entryPath);
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        return [entryPath];
      }
      return [];
    })
  );
  return files.flat();
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function hasRuntimeExtension(specifier: string): boolean {
  return ALLOWED_RUNTIME_EXTENSIONS.some((extension) => specifier.endsWith(extension));
}

async function findMissingRuntimeExtensions(): Promise<string[]> {
  const failures: string[] = [];
  const files = await listTypeScriptFiles(SOURCE_ROOT);

  for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) {
          continue;
        }
        const specifier = statement.moduleSpecifier;
        if (!ts.isStringLiteral(specifier)) {
          continue;
        }
        if (isRelativeSpecifier(specifier.text) && !hasRuntimeExtension(specifier.text)) {
          failures.push(`${path.relative(SOURCE_ROOT, filePath)} imports ${specifier.text}`);
        }
        continue;
      }

      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) {
          continue;
        }
        const specifier = statement.moduleSpecifier;
        if (!(specifier && ts.isStringLiteral(specifier))) {
          continue;
        }
        if (isRelativeSpecifier(specifier.text) && !hasRuntimeExtension(specifier.text)) {
          failures.push(`${path.relative(SOURCE_ROOT, filePath)} exports ${specifier.text}`);
        }
      }
    }
  }

  return failures.sort();
}

describe('runtime import extensions', () => {
  it('uses explicit runtime extensions for relative ESM imports and exports', async () => {
    await expect(findMissingRuntimeExtensions()).resolves.toEqual([]);
  });
});
