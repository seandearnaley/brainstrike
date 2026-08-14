import ts from 'typescript';

function propertyMap(object, at) {
  const result = new Map();
  for (const item of object.properties) {
    if (
      !(
        ts.isPropertyAssignment(item) &&
        (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
      )
    ) {
      throw new Error(`unsupported computed/spread/shorthand registry shape at ${at}`);
    }
    if (result.has(item.name.text)) {
      throw new Error(`duplicate registry field at ${at}/${item.name.text}`);
    }
    result.set(item.name.text, item);
  }
  return result;
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
  if (ts.isIdentifier(node)) {
    if (!constants.has(node.text)) {
      throw new Error(`unresolved registry initializer: ${node.text}`);
    }
    return constants.get(node.text);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((item) => evaluate(item, constants));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      [...propertyMap(node, 'evaluated object')].map(([name, item]) => [
        name,
        evaluate(item.initializer, constants),
      ])
    );
  }
  throw new Error(`unsupported registry initializer: ${ts.SyntaxKind[node.kind]}`);
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

export function parseProviderRegistry({ registrySource, importedStringConstants = {} }) {
  const file = ts.createSourceFile(
    'provider-registry.ts',
    registrySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  if (file.parseDiagnostics.length > 0) {
    throw new Error('registry source has TypeScript parse diagnostics');
  }
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
          if (definitions) {
            throw new Error('duplicate PROVIDER_DEFINITIONS declaration');
          }
          definitions = declaration.initializer;
        }
      }
    }
  }
  definitions = unwrapExpression(definitions);
  if (!(definitions && ts.isArrayLiteralExpression(definitions))) {
    throw new Error('PROVIDER_DEFINITIONS must be an array literal');
  }
  const models = [];
  const ids = new Set();
  const providerIds = new Set();
  const providerCounts = {};
  for (const [providerIndex, providerNode] of definitions.elements.entries()) {
    if (!ts.isObjectLiteralExpression(providerNode)) {
      throw new Error('provider must be an object literal');
    }
    const providerProperties = propertyMap(providerNode, `provider ${providerIndex}`);
    const idNode = providerProperties.get('id');
    const modelsNode = providerProperties.get('models');
    if (!(idNode && modelsNode && ts.isArrayLiteralExpression(modelsNode.initializer))) {
      throw new Error('provider models must be an array literal');
    }
    const providerId = evaluate(idNode.initializer, constants);
    if (typeof providerId !== 'string') {
      throw new Error('provider ID must resolve to string');
    }
    if (providerIds.has(providerId)) {
      throw new Error(`duplicate provider ID: ${providerId}`);
    }
    providerIds.add(providerId);
    providerCounts[providerId] = modelsNode.initializer.elements.length;
    for (const [modelIndex, modelNode] of modelsNode.initializer.elements.entries()) {
      if (!ts.isObjectLiteralExpression(modelNode)) {
        throw new Error('model must be an object literal');
      }
      const modelProperties = propertyMap(modelNode, `provider ${providerId}/model ${modelIndex}`);
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
        const node = modelProperties.get(name);
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
