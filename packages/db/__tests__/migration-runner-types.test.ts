import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

function collectTypeDiagnostics(entryPoint: string): readonly ts.Diagnostic[] {
  const configPath = ts.findConfigFile(PACKAGE_ROOT, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    throw new Error('Unable to find packages/db/tsconfig.json');
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return [configFile.error];
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    PACKAGE_ROOT,
    {
      composite: false,
      declaration: false,
      declarationDir: undefined,
      declarationMap: false,
      incremental: false,
      noEmit: true,
      rootDir: PACKAGE_ROOT,
      tsBuildInfoFile: undefined,
    },
    configPath
  );

  const program = ts.createProgram({
    options: parsed.options,
    rootNames: [entryPoint],
  });

  return ts.getPreEmitDiagnostics(program);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }

  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const relativeFile = path.relative(PACKAGE_ROOT, diagnostic.file.fileName);
  return `${relativeFile}:${location.line + 1}:${location.character + 1} ${message}`;
}

describe('Migration callback type contract', () => {
  it('exposes only the transactional DB methods to function-style migrations', () => {
    const fixturePath = path.join(
      PACKAGE_ROOT,
      '__tests__/type-fixtures/migration-callback-contract.ts'
    );

    const diagnostics = collectTypeDiagnostics(fixturePath).map(formatDiagnostic);

    expect(diagnostics).toEqual([]);
  });
});
