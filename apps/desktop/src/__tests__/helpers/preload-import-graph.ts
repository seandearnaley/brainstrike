import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Walks the VALUE-import graph of a preload entry (BST-1648). Type-only
 * imports are skipped because the bundler erases them; every other import
 * is classified: relative or explicitly bundled alias → resolved and walked;
 * other bare packages, `node:*`, and `electron` → a violation, because
 * `scripts/build-main-config.mjs` leaves those as `require(...)` calls a
 * sandboxed preload cannot resolve. The entry file itself may `require()`
 * only what `allowedEntryRequires` lists.
 */
export interface PreloadImportGraphViolation {
  readonly file: string;
  readonly reason: string;
  readonly specifier: string;
}

export interface PreloadImportGraph {
  /** Absolute paths of every walked module, sorted. */
  readonly modules: readonly string[];
  readonly violations: readonly PreloadImportGraphViolation[];
}

interface PreloadImportGraphOptions {
  readonly allowedEntryRequires: readonly string[];
  readonly bundledAliases?: Readonly<Record<string, string>> | undefined;
}

const RESOLUTION_CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'] as const;

function resolveRelativeSpecifier(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  // esbuild substitutes TypeScript sources for NodeNext .js specifiers.
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, base]
    : RESOLUTION_CANDIDATES.map((suffix) => `${base}${suffix}`);
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`Cannot resolve preload import '${specifier}' from ${fromFile}.`);
}

function isTypeOnlyImport(declaration: ts.ImportDeclaration): boolean {
  const clause = declaration.importClause;
  if (!clause) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name) {
    return false;
  }
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) {
    return false;
  }
  return bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(declaration: ts.ExportDeclaration): boolean {
  if (declaration.isTypeOnly) {
    return true;
  }
  const clause = declaration.exportClause;
  return Boolean(
    clause && ts.isNamedExports(clause) && clause.elements.every((element) => element.isTypeOnly)
  );
}

function stringArgument(node: ts.CallExpression): string | null {
  const [argument] = node.arguments;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function isRequireCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && node.expression.text === 'require';
}

function isDynamicImport(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

interface ValueImport {
  /** `non-literal` marks a require()/import() whose argument is not a string literal. */
  readonly kind: 'import' | 'non-literal' | 'require';
  readonly specifier: string;
}

function collectValueImports(sourceFile: ts.SourceFile): ValueImport[] {
  const imports: ValueImport[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push({ kind: 'import', specifier: node.moduleSpecifier.text });
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        !isTypeOnlyExport(node)
      ) {
        imports.push({ kind: 'import', specifier: node.moduleSpecifier.text });
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteralLike(reference.expression)) {
        imports.push({ kind: 'require', specifier: reference.expression.text });
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const specifier = stringArgument(node);
      const loadsModule = isRequireCall(node) || isDynamicImport(node);
      if (loadsModule && specifier === null) {
        // The bundler cannot inline a computed specifier and esbuild's node
        // target preserves the call, so the sandboxed preload would resolve it
        // (or fail to) at runtime. Never let it through silently.
        imports.push({ kind: 'non-literal', specifier: node.getText(sourceFile) });
      } else if (specifier !== null && isRequireCall(node)) {
        imports.push({ kind: 'require', specifier });
      } else if (specifier !== null && isDynamicImport(node)) {
        imports.push({ kind: 'import', specifier });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

export function collectPreloadImportGraph(
  entryFile: string,
  options: PreloadImportGraphOptions
): PreloadImportGraph {
  const entry = path.resolve(entryFile);
  const walked = new Set<string>();
  const violations: PreloadImportGraphViolation[] = [];
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (walked.has(file)) {
      continue;
    }
    walked.add(file);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    for (const { kind, specifier } of collectValueImports(sourceFile)) {
      if (kind === 'non-literal') {
        violations.push({
          file,
          reason:
            'require()/import() with a non-literal argument (the bundler cannot inline it; use a string literal)',
          specifier,
        });
        continue;
      }
      const bundledAlias = options.bundledAliases?.[specifier];
      if (bundledAlias && kind === 'import') {
        queue.push(resolveRelativeSpecifier(file, bundledAlias));
        continue;
      }
      if (isRelativeSpecifier(specifier)) {
        if (kind === 'require') {
          violations.push({
            file,
            reason: 'require() of a relative module (use an import so the bundler inlines it)',
            specifier,
          });
          continue;
        }
        queue.push(resolveRelativeSpecifier(file, specifier));
        continue;
      }
      if (
        kind === 'require' &&
        file === entry &&
        options.allowedEntryRequires.includes(specifier)
      ) {
        continue;
      }
      violations.push({
        file,
        reason:
          kind === 'require'
            ? `require() outside the preload entry allowlist (${options.allowedEntryRequires.join(', ')})`
            : 'value import of a non-relative module (only relative modules bundle into a sandboxed preload)',
        specifier,
      });
    }
  }

  return { modules: [...walked].sort(), violations };
}
