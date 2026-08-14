import ts from 'typescript';

function property(object, name) {
  return object.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name
  );
}
function evaluate(node, constants) {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) {
    return null;
  }
  if (ts.isIdentifier(node) && constants.has(node.text)) {
    return constants.get(node.text);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((item) => evaluate(item, constants));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((item) => {
        if (
          !(
            ts.isPropertyAssignment(item) &&
            (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
          )
        ) {
          throw new Error('computed/spread registry field is forbidden');
        }
        return [item.name.text, evaluate(item.initializer, constants)];
      })
    );
  }
  return;
}
export function parseProviderRegistry({ registrySource, importedStringConstants = {} }) {
  const file = ts.createSourceFile(
    'provider-registry.ts',
    registrySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const constants = new Map(Object.entries(importedStringConstants));
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isStringLiteralLike(declaration.initializer)
        ) {
          constants.set(declaration.name.text, declaration.initializer.text);
        }
      }
    }
  }
  let definitions;
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'PROVIDER_DEFINITIONS') {
          definitions = declaration.initializer;
        }
      }
    }
  }
  if (definitions && ts.isAsExpression(definitions)) {
    definitions = definitions.expression;
  }
  if (definitions && ts.isSatisfiesExpression(definitions)) {
    definitions = definitions.expression;
  }
  if (!(definitions && ts.isArrayLiteralExpression(definitions))) {
    throw new Error('PROVIDER_DEFINITIONS must be an array literal');
  }
  const models = [];
  const ids = new Set();
  const providerCounts = {};
  for (const providerNode of definitions.elements) {
    if (!ts.isObjectLiteralExpression(providerNode)) {
      throw new Error('provider must be an object literal');
    }
    const idNode = property(providerNode, 'id');
    const modelsNode = property(providerNode, 'models');
    if (!(idNode && modelsNode && ts.isArrayLiteralExpression(modelsNode.initializer))) {
      throw new Error('provider models must be an array literal');
    }
    const providerId = evaluate(idNode.initializer, constants);
    if (typeof providerId !== 'string') {
      throw new Error('provider ID must resolve to string');
    }
    providerCounts[providerId] = modelsNode.initializer.elements.length;
    for (const modelNode of modelsNode.initializer.elements) {
      if (!ts.isObjectLiteralExpression(modelNode)) {
        throw new Error('model must be an object literal');
      }
      const fields = {};
      for (const name of [
        'id',
        'type',
        'label',
        'contextWindow',
        'maxOutputTokens',
        'pricing',
        'supportsStreaming',
        'vision',
        'reasoning',
        'default',
      ]) {
        const node = property(modelNode, name);
        if (node) {
          fields[name] = evaluate(node.initializer, constants);
        }
      }
      if (typeof fields.id !== 'string' || ids.has(fields.id)) {
        throw new Error(`duplicate or unresolved global model ID: ${fields.id}`);
      }
      ids.add(fields.id);
      models.push({
        fields,
        id: fields.id,
        providerId,
        source: { end: modelNode.end, start: modelNode.getStart(file) },
      });
    }
  }
  return { models, providerCounts };
}
