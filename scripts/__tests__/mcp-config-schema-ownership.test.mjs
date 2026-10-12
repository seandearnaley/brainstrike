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

test('shared MCP grammar stays subpath-owned with capability-scoped adapters', () => {
  const owner = parseSource('packages/assistant-contract/src/mcp-config.ts');
  const root = parseSource('packages/assistant-contract/src/index.ts');
  const agent = parseSource('packages/agent/src/mcp/config.ts');
  const runtime = parseSource('packages/agent/src/mastra/mcp-runtime-client.ts');
  const desktop = parseSource('packages/host-capabilities/src/mcp/config-file.ts');

  assert.ok(callCount(owner, 'strictObject') > 0);
  assert.ok(callCount(owner, 'discriminatedUnion') > 0);
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
    assert.equal(callCount(adapter, 'strictObject'), 0, name);
    assert.equal(callCount(adapter, 'discriminatedUnion'), 0, name);
  }
  assert.ok(callCount(runtime, 'parseMcpConfigValue') > 0);
  assert.equal(callCount(runtime, 'parse', 'McpConfigSchema'), 0);
});
