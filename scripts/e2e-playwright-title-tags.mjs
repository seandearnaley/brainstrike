import { readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const PLAYWRIGHT_TITLE_MODIFIERS = new Set(['fixme', 'only', 'parallel', 'serial', 'skip']);

function getScriptKind(fileName) {
  if (fileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (fileName.endsWith('.mts')) {
    return ts.ScriptKind.TS;
  }
  if (fileName.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  if (fileName.endsWith('.ts')) {
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

function isPlaywrightTitleCall(expression) {
  const parts = getCalleeParts(expression);
  if (parts[0] !== 'test') {
    return false;
  }

  const chain = parts.slice(1);
  if (chain.length === 0) {
    return true;
  }

  if (chain[0] === 'describe') {
    return chain.slice(1).every((part) => PLAYWRIGHT_TITLE_MODIFIERS.has(part));
  }

  return chain.length === 1 && PLAYWRIGHT_TITLE_MODIFIERS.has(chain[0]);
}

function getLiteralText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function getCallbackRangeEnd(node) {
  const callback = node.arguments.find(
    (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
  );
  if (!callback) {
    return node.end;
  }
  return callback.body.end;
}

export function findTaggedPlaywrightTitleRanges(source, fileName, tag) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(fileName)
  );
  const ranges = [];

  function visit(node) {
    if (ts.isCallExpression(node) && isPlaywrightTitleCall(node.expression)) {
      const title = node.arguments[0] ? getLiteralText(node.arguments[0]) : null;
      if (title?.includes(tag)) {
        ranges.push({
          end: getCallbackRangeEnd(node),
          start: node.getStart(sourceFile),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return ranges;
}

export function hasPlaywrightTitleTag(source, fileName, tag) {
  return findTaggedPlaywrightTitleRanges(source, fileName, tag).length > 0;
}

export function isInsideRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

export async function listTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listTestFiles(fullPath);
      }
      if (entry.isFile() && /\.test\.[cm]?[tj]sx?$/.test(entry.name)) {
        return [fullPath];
      }
      return [];
    })
  );

  return files.flat();
}
