import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepoFile = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8');
const parseSource = (relativePath) =>
  ts.createSourceFile(
    relativePath,
    readRepoFile(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

function descendants(sourceFile, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return matches;
}

function importsFrom(sourceFile, moduleName) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleName
  );
}

function callCount(sourceFile, name, receiver) {
  return descendants(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      (ts.isIdentifier(node.expression)
        ? node.expression.text === name
        : ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === name &&
          (receiver === undefined ||
            (ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === receiver)))
  ).length;
}

function identifierCount(sourceFile, name) {
  return descendants(sourceFile, (node) => ts.isIdentifier(node) && node.text === name).length;
}

function importSourceOf(sourceFile, binding) {
  const declaration = sourceFile.statements.find(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((element) => element.name.text === binding)
  );
  return declaration?.moduleSpecifier.text;
}

// Runtime decoders only; `Schema.decode` and `Schema.decodeTo` build transformations.
const DECODER = /^decode(?:Unknown)?(?:Effect|Exit|Option|Promise|Result|Sync)$/u;

function calleeName(call) {
  if (ts.isIdentifier(call.expression)) {
    return call.expression.text;
  }
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
}

function decodeCalls(sourceFile) {
  return descendants(
    sourceFile,
    (node) => ts.isCallExpression(node) && DECODER.test(calleeName(node))
  );
}

function rejectsExcessProperties(call) {
  const options = call.arguments[1];
  return (
    options !== undefined &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'onExcessProperty' &&
        ts.isStringLiteral(property.initializer) &&
        property.initializer.text === 'error'
    )
  );
}

function looseDecodes(sourceFile) {
  return decodeCalls(sourceFile)
    .filter((call) => !rejectsExcessProperties(call))
    .map(
      (call) =>
        `${sourceFile.fileName}:${sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1}`
    );
}

test('shared MCP grammar stays subpath-owned with capability-scoped adapters', () => {
  const owner = parseSource('packages/assistant-contract/src/mcp-config.ts');
  const root = parseSource('packages/assistant-contract/src/index.ts');
  const agent = parseSource('packages/agent/src/mcp/config.ts');
  const runtime = parseSource('packages/agent/src/mcp/mcp-runtime-client.ts');
  const desktop = parseSource('packages/host-capabilities/src/mcp/config-file.ts');

  // Effect Schema owns the shared grammar (ADR-0024): object shapes are
  // `Schema.Struct`, the transport variants a `Schema.Union`.
  assert.ok(importsFrom(owner, 'effect'));
  assert.equal(importsFrom(owner, 'zod'), false, 'the shared grammar has one schema library');
  assert.ok(callCount(owner, 'Struct', 'Schema') > 0);
  assert.ok(callCount(owner, 'Union', 'Schema') > 0);
  // zod's strictObject made strictness part of the grammar. Effect has no
  // schema-level equivalent: ParseOptions.onExcessProperty defaults to
  // "ignore", which strips unknown keys, so every decode must opt in.
  assert.ok(decodeCalls(owner).length > 0, 'the owner decodes the shared grammar');
  assert.deepEqual(looseDecodes(owner), [], 'every decode must pass onExcessProperty: "error"');
  assert.equal(
    root.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === './mcp-config.js'
    ),
    false,
    'the shared MCP grammar must remain available only from its explicit package subpath'
  );

  for (const [name, adapter] of [
    ['agent', agent],
    ['desktop', desktop],
  ]) {
    assert.ok(importsFrom(adapter, '@brainstrike/assistant-contract/mcp-config'), name);
    assert.ok(callCount(adapter, 'parseMcpConfigValue') > 0, name);
    assert.equal(importsFrom(adapter, 'zod'), false, `${name} must not own the shared grammar`);
    // Adapters may refine the shared schema (`.check`) but never declare shapes.
    for (const shape of ['Struct', 'StructWithRest', 'Union']) {
      assert.equal(
        callCount(adapter, shape),
        0,
        `${name} must not own the shared grammar (${shape})`
      );
    }
    assert.deepEqual(
      looseDecodes(adapter),
      [],
      `${name} decodes must pass onExcessProperty: "error"`
    );
  }
  assert.ok(callCount(runtime, 'parseMcpConfigValue') > 0);
  assert.equal(
    importSourceOf(runtime, 'parseMcpConfigValue'),
    './config',
    'the runtime client decodes through the capability-scoped agent adapter'
  );
  assert.equal(
    identifierCount(runtime, 'McpConfigSchema'),
    0,
    'the runtime client decodes through parseMcpConfigValue, never the schema itself'
  );
});
