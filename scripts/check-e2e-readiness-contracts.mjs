#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

import {
  findTaggedPlaywrightTitleRanges,
  isInsideRange,
} from './e2e-playwright-title-tags.mjs';

const rootDir = process.cwd();
const webE2EDir = path.join(rootDir, 'apps/web/e2e');

function getScriptKind(fileName) {
  if (fileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (fileName.endsWith('.mts') || fileName.endsWith('.cts') || fileName.endsWith('.ts')) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function getCalleeParts(expression) {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return [...getCalleeParts(expression.expression), expression.name.text];
  }
  return [];
}

function isPlaywrightTestCall(node) {
  const calleeParts = getCalleeParts(node.expression);
  if (calleeParts[0] !== 'test') {
    return false;
  }

  if (calleeParts.length === 1) {
    return true;
  }

  return ['fixme', 'only', 'skip'].includes(calleeParts[1]) && calleeParts.length === 2;
}

function hasBooleanProperty(node, propertyName, expectedValue) {
  if (!ts.isObjectLiteralExpression(node)) {
    return false;
  }

  return node.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const name = property.name;
    const initializer = property.initializer;
    const matchesName =
      (ts.isIdentifier(name) && name.text === propertyName) ||
      (ts.isStringLiteral(name) && name.text === propertyName);

    if (!matchesName) {
      return false;
    }

    return expectedValue
      ? initializer.kind === ts.SyntaxKind.TrueKeyword
      : initializer.kind === ts.SyntaxKind.FalseKeyword;
  });
}

function hasExplicitShellOnlyOption(node) {
  return hasBooleanProperty(node, 'waitForDatabase', false);
}

function isFastShardDbReadinessCall(node) {
  const calleeParts = getCalleeParts(node.expression);
  const calleeName = calleeParts.at(-1);

  if (calleeName === 'waitForAppLoad') {
    const options = node.arguments[1];
    if (!options || !hasExplicitShellOnlyOption(options)) {
      return 'waitForAppLoad defaults to DB readiness in a fast functional path';
    }
  }

  if (calleeName === 'resetLayoutState') {
    const options = node.arguments[1];
    if (!options || !hasExplicitShellOnlyOption(options)) {
      return 'resetLayoutState defaults to DB readiness in a fast functional path';
    }
  }

  if (calleeParts.length === 2 && calleeParts[0] === 'home' && calleeParts[1] === 'goto') {
    const options = node.arguments[0];
    if (!options || !hasExplicitShellOnlyOption(options)) {
      return 'HomePage.goto defaults to DB readiness in a fast functional path';
    }
  }

  return null;
}

function lineForPosition(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

export function findFastShardDbReadinessViolations(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(file)
  );
  const isolatedRanges = [
    ...findTaggedPlaywrightTitleRanges(source, file, '@stateful'),
    ...findTaggedPlaywrightTitleRanges(source, file, '@destructive'),
  ];
  const violations = [];
  let hasFastShardTest = false;

  function visit(node) {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const position = node.getStart(sourceFile);
    const insideIsolatedRange = isInsideRange(position, isolatedRanges);

    if (isPlaywrightTestCall(node) && !insideIsolatedRange) {
      hasFastShardTest = true;
    }

    if (!insideIsolatedRange) {
      const reason = isFastShardDbReadinessCall(node);
      if (reason) {
        violations.push({
          file,
          line: lineForPosition(sourceFile, position),
          reason,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hasFastShardTest ? violations : [];
}

async function listFunctionalWebTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'performance') {
          return [];
        }
        return listFunctionalWebTestFiles(fullPath);
      }
      if (entry.isFile() && /\.test\.[cm]?[tj]sx?$/.test(entry.name)) {
        return [fullPath];
      }
      return [];
    })
  );

  return files.flat();
}

function formatViolation(violation) {
  return `${violation.file}:${violation.line} - ${violation.reason}`;
}

async function main() {
  const files = await listFunctionalWebTestFiles(webE2EDir);
  const violations = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const repoRelativeFile = path.relative(rootDir, file);
    violations.push(...findFastShardDbReadinessViolations(source, repoRelativeFile));
  }

  if (violations.length > 0) {
    console.error('E2E readiness contract check failed.');
    console.error(
      'Fast functional web E2E paths must not wait for database readiness outside @stateful or @destructive title ranges.'
    );
    console.error(violations.map(formatViolation).join('\n'));
    process.exit(1);
  }

  console.log('E2E readiness contract check passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
