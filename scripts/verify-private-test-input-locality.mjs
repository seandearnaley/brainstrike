import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseRepoRootArgument(argv) {
  if (argv.length === 0) {
    return;
  }
  const [argument, value] = argv;
  if (argv.length !== 2 || argument !== '--repo-root' || !value || value.startsWith('--')) {
    throw new Error('verify-private-test-input-locality: expected only --repo-root <path>');
  }
  return path.resolve(value);
}

export const PILOTS = [
  {
    packageDirectory: 'packages/types',
    privateTestPatterns: ['**/*.test.*', '**/*.spec.*'],
  },
];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const READ_CALL =
  /^(?:readFile|readFileSync|createReadStream|open|openSync|access|accessSync|stat|statSync|readdir|readdirSync|glob|globSync|existsSync|opendir|opendirSync|copyFile|copyFileSync|cp|cpSync)$/u;
const MAX_PATH_ALTERNATIVES = 64;

function boundedAlternatives(values) {
  if (values.length <= MAX_PATH_ALTERNATIVES) {
    return values;
  }
  const discardedPrivateShape = values.some(
    (value) =>
      value.includes('/__tests__') || /(^|\/)[^/]*\.(?:test|spec)(?:\.[^/]*)?$/u.test(value)
  );
  return discardedPrivateShape ? ['*/*/__tests__/*.test.*'] : ['*/*'];
}

function trackedSourceFiles(root) {
  if (!existsSync(path.join(root, '.git'))) {
    throw new Error(`Private test input locality cannot verify ${root}: no Git metadata found.`);
  }
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter((file) => SOURCE_EXTENSION.test(file) && existsSync(path.join(root, file)));
}

function literalAlternatives(node, bindings = new Map(), seen = new Set()) {
  if (ts.isStringLiteralLike(node)) {
    return [node.text];
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalAlternatives(node.left, bindings, seen);
    const right = literalAlternatives(node.right, bindings, seen);
    return boundedAlternatives(
      (left.length ? left : ['*']).flatMap((prefix) =>
        (right.length ? right : ['*']).map((suffix) => prefix + suffix)
      )
    );
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce(
      (prefixes, span) =>
        boundedAlternatives(
          prefixes.flatMap((prefix) =>
            (literalAlternatives(span.expression, bindings, seen).length
              ? literalAlternatives(span.expression, bindings, seen)
              : ['*']
            ).map((value) => `${prefix}${value}${span.literal.text}`)
          )
        ),
      [node.head.text]
    );
  }
  if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) {
    return boundedAlternatives(
      bindings
        .get(node.text)
        .flatMap((binding) => literalAlternatives(binding, bindings, new Set([...seen, node.text])))
    );
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ['join', 'resolve'].includes(node.expression.name.text)
  ) {
    return node.arguments.reduce(
      (prefixes, argument) => {
        const values = literalAlternatives(argument, bindings, seen);
        return boundedAlternatives(
          prefixes.flatMap((prefix) =>
            (values.length ? values : ['*']).map((value) => path.join(prefix, value))
          )
        );
      },
      ['']
    );
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL'
  ) {
    return node.arguments?.length ? literalAlternatives(node.arguments[0], bindings, seen) : [];
  }
  return [];
}

function literalText(node, bindings = new Map()) {
  const alternatives = literalAlternatives(node, bindings);
  return alternatives.length ? alternatives.join('|') : undefined;
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
  const visit = (expression) => {
    const exact = literalAlternatives(expression, bindings);
    if (exact.length) {
      return exact;
    }
    if (ts.isConditionalExpression(expression)) {
      return [...visit(expression.whenTrue), ...visit(expression.whenFalse)];
    }
    const children = [];
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      children.push(...(expression.arguments ?? []));
    } else {
      ts.forEachChild(expression, (child) => {
        children.push(child);
      });
    }
    if (children.length === 0) {
      return ['*'];
    }
    return children.reduce(
      (prefixes, child) => {
        const values = visit(child);
        return boundedAlternatives(
          prefixes.flatMap((prefix) => values.map((value) => path.join(prefix, value)))
        );
      },
      ['']
    );
  };
  return visit(node).join('|');
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
    if (
      (/^(?:\*\/){2,}/u.test(candidateSpecifier) ||
        /(?:^|\/)packages\/\*\//u.test(candidateSpecifier)) &&
      (candidateSpecifier.includes('/__tests__') ||
        /(^|\/)[^/]*\.(?:test|spec)(?:\.[^/]*)?$/u.test(candidateSpecifier))
    ) {
      return true;
    }
    const candidate = packageRelativeTarget(candidateSpecifier, importer, pilot);
    if (candidate === undefined) {
      return false;
    }
    if (
      candidate === '__tests__' ||
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
    const fsObjects = new Set();
    const aliasDefinitions = [];
    const isFsModule = (value) =>
      ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(value);
    const isRequireFs = (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isFsModule(node.arguments[0].text);
    const isImportFs = (node) =>
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isFsModule(node.arguments[0].text);
    const memberName = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        return node.name.text;
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        return node.argumentExpression.text;
      }
    };
    const isFsObject = (node) => {
      if (ts.isIdentifier(node)) {
        return fsObjects.has(node.text);
      }
      if (ts.isAwaitExpression(node)) {
        return isFsObject(node.expression);
      }
      if (isRequireFs(node) || isImportFs(node)) {
        return true;
      }
      return (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        memberName(node) === 'promises' &&
        isFsObject(node.expression)
      );
    };
    const addDestructuredAliases = (pattern, expression) => {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) {
          continue;
        }
        const property = element.propertyName ?? element.name;
        const member = ts.isIdentifier(property)
          ? ts.factory.createPropertyAccessExpression(expression, property)
          : ts.factory.createElementAccessExpression(expression, property);
        if (ts.isIdentifier(element.name)) {
          aliasDefinitions.push({ expression: member, name: element.name.text });
          if (READ_CALL.test(property.text) && isFsObject(expression)) {
            readAliases.add(element.name.text);
          }
        } else if (ts.isObjectBindingPattern(element.name)) {
          addDestructuredAliases(element.name, member);
        }
      }
    };
    const collectBindings = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const candidates = bindings.get(node.name.text) ?? [];
        candidates.push(node.initializer);
        bindings.set(node.name.text, candidates);
        aliasDefinitions.push({ expression: node.initializer, name: node.name.text });
        if (isFsObject(node.initializer)) {
          fsObjects.add(node.name.text);
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const candidates = bindings.get(node.left.text) ?? [];
        candidates.push(node.right);
        bindings.set(node.left.text, candidates);
        aliasDefinitions.push({ expression: node.right, name: node.left.text });
      }
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isFsModule(node.moduleSpecifier.text) &&
        node.importClause
      ) {
        if (node.importClause.name) {
          fsObjects.add(node.importClause.name.text);
        }
        if (node.importClause.namedBindings) {
          if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            fsObjects.add(node.importClause.namedBindings.name.text);
          } else {
            for (const element of node.importClause.namedBindings.elements) {
              const importedName = element.propertyName?.text ?? element.name.text;
              if (READ_CALL.test(importedName)) {
                readAliases.add(element.name.text);
              }
            }
          }
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        addDestructuredAliases(node.name, node.initializer);
      }
      ts.forEachChild(node, collectBindings);
    };
    collectBindings(source);
    let changed = true;
    while (changed) {
      changed = false;
      for (const { expression, name } of aliasDefinitions) {
        const isAlias =
          (ts.isIdentifier(expression) && readAliases.has(expression.text)) ||
          ((ts.isPropertyAccessExpression(expression) ||
            ts.isElementAccessExpression(expression)) &&
            READ_CALL.test(memberName(expression) ?? '') &&
            isFsObject(expression.expression));
        if (isAlias && !readAliases.has(name)) {
          readAliases.add(name);
          changed = true;
        }
      }
    }
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
    main({ repoRoot: parseRepoRootArgument(process.argv.slice(2)) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
