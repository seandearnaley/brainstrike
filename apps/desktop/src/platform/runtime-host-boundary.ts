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

interface ForbiddenExecutionImportRule {
  readonly matchSubpaths: boolean;
  readonly message: string;
  readonly source: string;
}

const FORBIDDEN_EXECUTION_IMPORTS: readonly ForbiddenExecutionImportRule[] = [
  {
    matchSubpaths: true,
    message: 'Built-in local LLM execution is renderer-only; Electron main must talk to llm-host.',
    source: '@brainstrike/agent/local-llm',
  },
  {
    matchSubpaths: true,
    message:
      'Local embedding worker execution is renderer-only; Electron main must talk to embedding-host.',
    source: '@brainstrike/embeddings/worker',
  },
  {
    matchSubpaths: false,
    message:
      'The embeddings root entrypoint exports renderer-only worker execution; Electron main must import hosted provider contracts from @brainstrike/embeddings/provider-core.',
    source: '@brainstrike/embeddings',
  },
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const MAX_SOURCE_WALK_DEPTH = 20;

function toSourcePath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/');
}

function isRendererSource(filePath: string): boolean {
  const normalizedPath = toSourcePath(filePath);
  return normalizedPath.startsWith('src/renderer/') || normalizedPath.includes('/src/renderer/');
}

function isTestSource(filePath: string): boolean {
  const normalizedPath = toSourcePath(filePath);
  return (
    normalizedPath.includes('/__tests__/') ||
    normalizedPath.endsWith('.test.ts') ||
    normalizedPath.endsWith('.test.tsx') ||
    normalizedPath.endsWith('.spec.ts') ||
    normalizedPath.endsWith('.spec.tsx')
  );
}

function collectDesktopSourceFilesFrom(
  directory: string,
  rootDirectory: string,
  depth: number
): RuntimeHostSourceFile[] {
  if (depth > MAX_SOURCE_WALK_DEPTH) {
    return [];
  }
  const files: RuntimeHostSourceFile[] = [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry);
    const stats = (() => {
      try {
        return lstatSync(absolutePath);
      } catch {
        return null;
      }
    })();
    if (!stats) {
      continue;
    }

    if (stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') {
        continue;
      }
      files.push(...collectDesktopSourceFilesFrom(absolutePath, rootDirectory, depth + 1));
      continue;
    }

    if (!(stats.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry)))) {
      continue;
    }

    files.push({
      path: toSourcePath(path.relative(rootDirectory, absolutePath)),
      source: (() => {
        try {
          return readFileSync(absolutePath, 'utf8');
        } catch {
          return '';
        }
      })(),
    });
  }

  return files;
}

export function collectDesktopSourceFiles(directory: string): RuntimeHostSourceFile[] {
  return collectDesktopSourceFilesFrom(directory, path.dirname(directory), 0);
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
  const rule = importSource
    ? FORBIDDEN_EXECUTION_IMPORTS.find(
        (candidate) =>
          importSource === candidate.source ||
          (candidate.matchSubpaths && importSource.startsWith(`${candidate.source}/`))
      )
    : null;

  if (!(importSource && rule)) {
    return;
  }

  violations.push({ importSource, message: rule.message, path: filePath });
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
