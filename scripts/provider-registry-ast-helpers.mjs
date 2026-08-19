/**
 * Shared TypeScript-AST helpers for scripts that read the static provider
 * tables as DATA (BST-1361 review 10g): the model-catalog migration contract
 * and the provider-env-keys mirror contract both parse
 * `packages/assistant-contract/src/provider-registry.ts` (and mirrors of it)
 * without executing it, so the walk logic lives once, here.
 *
 * NOT a guard entrypoint — pure library module. Guard scripts import from it.
 */

import ts from 'typescript';

export function parseTypeScriptSource(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Strip `as const`/`satisfies`/parens wrappers down to the literal. */
export function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Initializer of `const <variableName> = ...` anywhere in the file, or undefined. */
export function findVariableInitializer(sourceFile, variableName) {
  let initializer;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializer;
}

/**
 * Read a static string-array literal. `onProblem(message)` is called for any
 * non-literal shape; entries that are not string literals are skipped after
 * reporting, so callers accumulate every problem instead of stopping at one.
 */
export function readStringArray(node, context, onProblem) {
  const arrayNode = unwrapExpression(node);
  if (!ts.isArrayLiteralExpression(arrayNode)) {
    onProblem(`${context} must be a static array literal`);
    return [];
  }
  const values = [];
  for (const element of arrayNode.elements) {
    if (ts.isStringLiteralLike(element)) {
      values.push(element.text);
    } else {
      onProblem(`${context} entries must be string literals`);
    }
  }
  return values;
}

/**
 * Read a provider-definition array (`PROVIDER_DEFINITIONS` /
 * `EMBEDDING_PROVIDER_DEFINITIONS`) into a Map keyed by literal provider id.
 * String-literal fields `id`, `authType`, and `runtime` are captured
 * directly; every field named in `arrayFields` is read as a string array.
 */
export function readProviderTable(sourceFile, variableName, arrayFields, onProblem) {
  const declaration = findVariableInitializer(sourceFile, variableName);
  if (!declaration) {
    onProblem(`${sourceFile.fileName} must declare ${variableName}`);
    return new Map();
  }
  const initializer = unwrapExpression(declaration);
  if (!ts.isArrayLiteralExpression(initializer)) {
    onProblem(`${variableName} must be a static array literal`);
    return new Map();
  }
  const providers = new Map();
  for (const element of initializer.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      onProblem(`${variableName} entries must be object literals`);
      continue;
    }
    const entry = {};
    for (const property of element.properties) {
      if (!(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))) {
        continue;
      }
      const name = property.name.text;
      if (name === 'id' || name === 'authType' || name === 'runtime') {
        if (ts.isStringLiteralLike(property.initializer)) {
          entry[name] = property.initializer.text;
        } else {
          onProblem(`${variableName} ${name} must be a string literal`);
        }
      } else if (arrayFields.includes(name)) {
        entry[name] = readStringArray(property.initializer, `${variableName} ${name}`, onProblem);
      }
    }
    if (entry.id) {
      providers.set(entry.id, entry);
    } else {
      onProblem(`${variableName} entry is missing a literal id`);
    }
  }
  return providers;
}
