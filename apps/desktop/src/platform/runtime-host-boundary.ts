import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface RuntimeHostSourceFile {
  path: string;
  source: string;
}

export interface RuntimeHostBoundaryViolation {
  importSource: string;
  message: string;
  path: string;
}

const FORBIDDEN_EXECUTION_IMPORTS = new Map<string, string>([
  [
    '@brainstrike/agent/local-llm',
    'Built-in local LLM execution is renderer-only; Electron main must talk to llm-host.',
  ],
  [
    '@brainstrike/embeddings/worker',
    'Local embedding worker execution is renderer-only; Electron main must talk to embedding-host.',
  ],
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function isRendererSource(filePath: string): boolean {
  return (
    filePath.startsWith('src/renderer/') ||
    filePath.includes('/src/renderer/') ||
    filePath.includes('\\src\\renderer\\')
  );
}

function isTestSource(filePath: string): boolean {
  return (
    filePath.includes('/__tests__/') ||
    filePath.includes('\\__tests__\\') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.tsx') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.tsx')
  );
}

function collectDesktopSourceFiles(directory: string): RuntimeHostSourceFile[] {
  const files: RuntimeHostSourceFile[] = [];

  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);

    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') {
        continue;
      }
      files.push(...collectDesktopSourceFiles(absolutePath));
      continue;
    }

    if (!(stats.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry)))) {
      continue;
    }

    files.push({
      path: path.relative(process.cwd(), absolutePath),
      source: readFileSync(absolutePath, 'utf8'),
    });
  }

  return files;
}

function getImportSource(node: ts.ImportDeclaration): string | null {
  const moduleSpecifier = node.moduleSpecifier;
  if (!ts.isStringLiteral(moduleSpecifier)) {
    return null;
  }
  return moduleSpecifier.text;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  if (node.importClause?.isTypeOnly) {
    return true;
  }

  const namedBindings = node.importClause?.namedBindings;
  if (!(namedBindings && ts.isNamedImports(namedBindings))) {
    return false;
  }

  return namedBindings.elements.every((element) => element.isTypeOnly);
}

export function findRuntimeHostBoundaryViolations(
  files: readonly RuntimeHostSourceFile[]
): RuntimeHostBoundaryViolation[] {
  const violations: RuntimeHostBoundaryViolation[] = [];

  for (const file of files) {
    if (isRendererSource(file.path) || isTestSource(file.path)) {
      continue;
    }

    const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || isTypeOnlyImport(statement)) {
        continue;
      }

      const importSource = getImportSource(statement);
      if (!importSource) {
        continue;
      }

      const message = FORBIDDEN_EXECUTION_IMPORTS.get(importSource);
      if (!message) {
        continue;
      }

      violations.push({ importSource, message, path: file.path });
    }
  }

  return violations;
}

export function findRuntimeHostBoundaryViolationsInDesktopSource(): RuntimeHostBoundaryViolation[] {
  return findRuntimeHostBoundaryViolations(
    collectDesktopSourceFiles(path.resolve(process.cwd(), 'src'))
  );
}
