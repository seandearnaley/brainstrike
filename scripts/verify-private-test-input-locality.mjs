import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PILOTS = [
  {
    packageDirectory: 'packages/types',
    privateTestPatterns: ['**/*.test.*', '**/*.spec.*'],
  },
];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const READ_CALL =
  /^(?:readFile|readFileSync|createReadStream|open|openSync|access|accessSync|stat|statSync)$/u;

function trackedSourceFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
  })
    .toString('utf8')
    .split('\0')
    .filter((file) => SOURCE_EXTENSION.test(file) && existsSync(path.join(root, file)));
}

function literalText(node, bindings = new Map(), seen = new Set()) {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return `${literalText(node.left, bindings, seen) ?? '*'}${literalText(node.right, bindings, seen) ?? '*'}`;
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [
        literalText(span.expression, bindings, seen) ?? '*',
        span.literal.text,
      ]),
    ].join('');
  }
  if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
    return bindings
      .get(node.text)
      .map((binding) => literalText(binding, bindings, new Set([...seen, node.text])) ?? '*')
      .join('|');
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ['join', 'resolve'].includes(node.expression.name.text)
  ) {
    const parts = node.arguments.map((argument) => literalText(argument, bindings, seen) ?? '*');
    return path.join(...parts);
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL'
  ) {
    return node.arguments?.length ? literalText(node.arguments[0], bindings, seen) : undefined;
  }
  return;
}

function importArgument(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
    return;
  }
  if (
    node.expression.kind !== ts.SyntaxKind.ImportKeyword &&
    !(ts.isIdentifier(node.expression) && node.expression.text === 'require')
  ) {
    return;
  }
  return node.arguments[0];
}

function fsReadArgument(node, readAliases) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) {
    return;
  }
  const name = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : undefined;
  return name && (READ_CALL.test(name) || readAliases.has(name)) ? node.arguments[0] : undefined;
}

function partialLiteralText(node, bindings) {
  const exact = literalText(node, bindings);
  if (exact !== undefined) {
    return exact;
  }
  const literals = [];
  const visit = (child) => {
    if (ts.isStringLiteralLike(child)) {
      literals.push(child.text);
    } else {
      ts.forEachChild(child, visit);
    }
  };
  visit(node);
  return literals.join('/');
}

function packageRelativeTarget(specifier, importer, pilot) {
  let normalized = specifier.replaceAll('\\', '/');
  const packagePrefix = `${pilot.packageDirectory}/`;
  const packageName = `@brainstrike/${path.basename(pilot.packageDirectory)}/`;
  if (normalized.startsWith(packageName)) {
    normalized = packagePrefix + normalized.slice(packageName.length);
  }
  const relative = normalized.startsWith('.')
    ? path.relative(repoRoot, path.resolve(path.dirname(path.join(repoRoot, importer)), normalized))
    : normalized;
  const resolved = relative.replaceAll('\\', '/').replace(/^\.\//u, '');
  const packageOffset = resolved.indexOf(packagePrefix);
  if (packageOffset === -1) {
    return;
  }
  return resolved.slice(packageOffset + packagePrefix.length);
}

function isExcludedFile(specifier, importer, pilot) {
  const inside = packageRelativeTarget(specifier, importer, pilot);
  return inside !== undefined && /(^|\/)[^/]+\.(?:test|spec)(?:\.[^/]+)?$/u.test(inside);
}

function isUnsafeTarget(specifier, importer, pilot) {
  return specifier.split('|').some((candidateSpecifier) => {
    const candidate = packageRelativeTarget(candidateSpecifier, importer, pilot);
    if (candidate === undefined) {
      return false;
    }
    if (
      candidate.startsWith('__tests__/') ||
      candidate.includes('/__tests__/') ||
      candidate.includes('*')
    ) {
      return true;
    }
    return /(^|\/)[^/]+\.(?:test|spec)(?:\.[^/]+)?$/u.test(candidate);
  });
}

export function findPrivateTestReaders({ root = repoRoot, files = trackedSourceFiles(root) } = {}) {
  const findings = [];
  for (const file of files) {
    const sourceText = readFileSync(path.join(root, file), 'utf8');
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const bindings = new Map();
    const readAliases = new Set();
    const collectBindings = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const candidates = bindings.get(node.name.text) ?? [];
        candidates.push(node.initializer);
        bindings.set(node.name.text, candidates);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const candidates = bindings.get(node.left.text) ?? [];
        candidates.push(node.right);
        bindings.set(node.left.text, candidates);
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(node.moduleSpecifier.text) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (READ_CALL.test(importedName)) {
            readAliases.add(element.name.text);
          }
        }
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(source);
    const visit = (node) => {
      const importedArgument = importArgument(node);
      const imported = importedArgument ? literalText(importedArgument, bindings) : undefined;
      const readArgument = fsReadArgument(node, readAliases);
      const read = readArgument ? literalText(readArgument, bindings) : undefined;
      let target = imported ?? read;
      if (target === undefined && importedArgument) {
        target = partialLiteralText(importedArgument, bindings);
      }
      if (target === undefined && readArgument) {
        // A read composed from variables is allowed only when its literal
        // fragments cannot name this pilot. This bounded policy supports the
        // repository's literal, path.join/path.resolve and new URL shapes; a
        // partially static read that can target the excluded package fails
        // closed rather than disappearing from the audit.
        target = partialLiteralText(readArgument, bindings);
      }
      if (target) {
        for (const pilot of PILOTS) {
          const importerIsPrivate = isExcludedFile(file, '', pilot);
          if (!importerIsPrivate && isUnsafeTarget(target, file, pilot)) {
            findings.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              target,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

export function verifyPrivateTestInputLocality(options) {
  const findings = findPrivateTestReaders(options);
  if (findings.length === 0) {
    return;
  }
  const details = findings
    .map(({ file, line, target }) => `  ${file}:${line} -> ${target}`)
    .join('\n');
  throw new Error(
    `Private test input locality is unsafe. Move shared contracts/fixtures outside excluded test paths before narrowing topo inputs:\n${details}`
  );
}

export function main({ repoRoot: root = repoRoot } = {}) {
  verifyPrivateTestInputLocality({ root });
  console.log('Private test input locality verified.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
