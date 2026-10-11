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

function getLiteralText(node, bindings = new Map()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isIdentifier(node)) {
    return bindings.get(node.text) ?? null;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = getLiteralText(span.expression, bindings);
      if (value === null) {
        return null;
      }
      text += value + span.literal.text;
    }
    return text;
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

function isPlaywrightDescribeCall(expression) {
  return getCalleeParts(expression)[1] === 'describe';
}

/**
 * Tags from Playwright's options form: `test(title, { tag: '@x' }, body)` and
 * `test.describe(title, { tag: ['@x', '@y'] }, body)`.
 *
 * These are NOT part of the title string, but Playwright appends them to the
 * string that `--grep` / `--grep-invert` / a project's `grep` are matched
 * against (`TestCase._grepTitleWithTags()` → `[...titlePath, ...tags]`), so a
 * caller that reads only title literals sees `{ tag: '@smoke' }` as untagged and
 * is wrong in both directions.
 *
 * `unresolved` is true when a details argument exists but its tags cannot be
 * read statically (an identifier instead of an object literal, a spread, a
 * computed value). Callers that need a sound answer must treat that as unknown
 * rather than as "no tags" — this module deliberately reports it instead of
 * throwing, so the tag-range consumers keep working.
 */
function getOwnTagsFromDetails(node) {
  const detailsArgument = node.arguments[1];
  if (!detailsArgument) {
    return { tags: [], unresolved: false };
  }
  if (ts.isArrowFunction(detailsArgument) || ts.isFunctionExpression(detailsArgument)) {
    return { tags: [], unresolved: false };
  }
  if (!ts.isObjectLiteralExpression(detailsArgument)) {
    // e.g. `test('t', SHARED_DETAILS, body)` — a details object exists but its
    // contents are elsewhere.
    return { tags: [], unresolved: true };
  }

  const tags = [];
  let unresolved = false;
  for (const property of detailsArgument.properties) {
    if (ts.isSpreadAssignment(property)) {
      // A spread can inject `tag` from anywhere.
      unresolved = true;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = property.name;
    const isTagKey = (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'tag';
    if (!isTagKey) {
      continue;
    }
    const initializer = property.initializer;
    const literal = getLiteralText(initializer);
    if (literal !== null) {
      tags.push(literal);
      continue;
    }
    if (ts.isArrayLiteralExpression(initializer)) {
      for (const element of initializer.elements) {
        const elementText = getLiteralText(element);
        if (elementText === null) {
          unresolved = true;
        } else {
          tags.push(elementText);
        }
      }
      continue;
    }
    unresolved = true;
  }
  return { tags, unresolved };
}

/**
 * Every `test(...)` / `test.describe(...)` title literal in a spec, in source
 * order, each carrying the enclosing describe titles and tags it inherits.
 *
 * `titlePath` reproduces Playwright's `TestCase._grepTitleWithTags()` exactly —
 * for each ancestor suite its title THEN its tags, then this node's own title,
 * then its own tags, space-joined. That is the string `--grep`,
 * `--grep-invert` and a project's `grep` are matched against, so a caller
 * modelling lane selection must filter on `titlePath`: a tag written on a
 * describe (in the title OR in the `{ tag }` options form) applies to every test
 * inside it.
 *
 * `tags` holds only this node's OWN options-form tags. `tagsUnresolved` marks a
 * node whose details argument could not be read statically.
 */
export function listPlaywrightTitleEntries(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(fileName)
  );
  const entries = [];

  // `inherited` mirrors Playwright's `_collectGrepTitlePath`: each ancestor
  // suite contributes its title followed immediately by its own tags.
  function visit(node, inherited, inheritedUnresolved, bindings = new Map()) {
    // Native-retirement tests register one case per literal mode. Expand that
    // finite table without executing the spec or guessing a dynamic title.
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      const [declaration] = node.initializer.declarations;
      let values = node.expression;
      while (ts.isAsExpression(values) || ts.isParenthesizedExpression(values)) {
        values = values.expression;
      }
      if (
        node.initializer.declarations.length === 1 &&
        ts.isIdentifier(declaration.name) &&
        ts.isArrayLiteralExpression(values)
      ) {
        const literals = values.elements.map((element) => getLiteralText(element, bindings));
        if (literals.every((literal) => literal !== null)) {
          for (const literal of literals) {
            const iteration = new Map(bindings);
            iteration.set(declaration.name.text, literal);
            visit(node.statement, inherited, inheritedUnresolved, iteration);
          }
          return;
        }
      }
    }
    let childInherited = inherited;
    let childUnresolved = inheritedUnresolved;

    if (ts.isCallExpression(node) && isPlaywrightTitleCall(node.expression)) {
      const title = node.arguments[0] ? getLiteralText(node.arguments[0], bindings) : null;
      if (title !== null) {
        const isDescribe = isPlaywrightDescribeCall(node.expression);
        const { tags, unresolved } = getOwnTagsFromDetails(node);
        const ownSegments = [title, ...tags];
        entries.push({
          end: getCallbackRangeEnd(node),
          kind: isDescribe ? 'describe' : 'test',
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          start: node.getStart(sourceFile),
          tags,
          tagsUnresolved: unresolved || inheritedUnresolved,
          title,
          titlePath: [...inherited, ...ownSegments].join(' '),
        });
        if (isDescribe) {
          childInherited = [...inherited, ...ownSegments];
          childUnresolved = unresolved || inheritedUnresolved;
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, childInherited, childUnresolved, bindings));
  }

  visit(sourceFile, [], false);
  return entries;
}

/**
 * Source ranges of title calls tagged `tag`, for "is this code inside a tagged
 * block" questions.
 *
 * Matches the node's OWN title or OWN options-form tags — inheritance needs no
 * special handling because an enclosing describe's range already contains every
 * descendant's source positions.
 */
export function findTaggedPlaywrightTitleRanges(source, fileName, tag) {
  return listPlaywrightTitleEntries(source, fileName)
    .filter(
      (entry) => entry.title.includes(tag) || entry.tags.some((ownTag) => ownTag.includes(tag))
    )
    .map((entry) => ({ end: entry.end, start: entry.start }));
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
