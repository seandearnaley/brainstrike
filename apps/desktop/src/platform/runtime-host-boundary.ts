import { lstatSync, readdirSync, readFileSync } from 'node:fs';
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

export function collectDesktopSourceFiles(directory: string): RuntimeHostSourceFile[] {
  const files: RuntimeHostSourceFile[] = [];

  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = lstatSync(absolutePath);

    if (stats.isSymbolicLink()) {
      continue;
    }

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

function getModuleSpecifierSource(
  node: ts.ImportDeclaration | ts.ExportDeclaration
): string | null {
  const moduleSpecifier = node.moduleSpecifier;
  if (!(moduleSpecifier && ts.isStringLiteral(moduleSpecifier))) {
    return null;
  }
  return moduleSpecifier.text;
}

function getForbiddenCallImportSource(node: ts.CallExpression): string | null {
  const [firstArgument] = node.arguments;
  if (!(firstArgument && ts.isStringLiteral(firstArgument))) {
    return null;
  }

  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return firstArgument.text;
  }

  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return firstArgument.text;
  }

  return null;
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

function getForbiddenImportSource(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node)) {
    return isTypeOnlyImport(node) ? null : getModuleSpecifierSource(node);
  }

  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly ? null : getModuleSpecifierSource(node);
  }

  if (ts.isCallExpression(node)) {
    return getForbiddenCallImportSource(node);
  }

  return null;
}

function appendForbiddenImportViolation(
  violations: RuntimeHostBoundaryViolation[],
  filePath: string,
  node: ts.Node
): void {
  const importSource = getForbiddenImportSource(node);
  const message = importSource ? FORBIDDEN_EXECUTION_IMPORTS.get(importSource) : null;

  if (!(importSource && message)) {
    return;
  }

  violations.push({ importSource, message, path: filePath });
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

    const visit = (node: ts.Node): void => {
      appendForbiddenImportViolation(violations, file.path, node);
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
}

export function findRuntimeHostBoundaryViolationsInDesktopSource(): RuntimeHostBoundaryViolation[] {
  return findRuntimeHostBoundaryViolations(
    collectDesktopSourceFiles(path.resolve(process.cwd(), 'src'))
  );
}
