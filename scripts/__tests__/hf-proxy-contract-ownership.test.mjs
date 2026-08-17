import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

const sharedContractSource = readFileSync(
  new URL('../../apps/web/src/hf-proxy-contract.ts', import.meta.url),
  'utf8'
);
const localInferenceContract = readFileSync(
  new URL('../../docs/agents/local-inference.md', import.meta.url),
  'utf8'
);
const devProxySource = readFileSync(
  new URL('../../apps/web/src/hf-dev-proxy.ts', import.meta.url),
  'utf8'
);
const productionProxySource = readFileSync(
  new URL('../../apps/web/src/app/api/hf/[...path]/route.ts', import.meta.url),
  'utf8'
);

const commonSharedConstantNames = [
  'HUGGING_FACE_BASE_URL',
  'ALLOWED_MODEL_ID',
  'FORWARDED_REQUEST_HEADERS',
  'PASSTHROUGH_RESPONSE_HEADERS',
];

const forbiddenProxyLiterals = [
  'https://huggingface.co',
  'onnx-community',
  'onnx-community/gemma-4-E2B-it-ONNX',
  '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9',
];

function parse(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function namedImportsFrom(sourceFile, moduleSuffix) {
  const imports = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith(moduleSuffix) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        imports.add(element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return imports;
}

function stringLiteralsIn(sourceFile) {
  const literals = new Set();
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      literals.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return literals;
}

describe('Hugging Face proxy contract ownership', () => {
  it('documents the web proxy ownership and verification seam', () => {
    const section = localInferenceContract.match(
      /^6\. Web Hugging Face proxy contract\n(?<body>[\s\S]*?)(?=^Constraints:)/m
    );
    assert.ok(section?.groups?.body, 'local-inference.md must define the web proxy contract');
    for (const requiredText of [
      'packages/assistant-contract/src/local-llm.ts',
      'apps/web/src/hf-proxy-contract.ts',
      'apps/web/src/hf-dev-proxy.ts',
      'apps/web/src/app/api/hf/[...path]/route.ts',
      'ALLOWED_MODEL_ID',
      'ALLOWED_MODEL_REVISION',
      'node --test scripts/__tests__/hf-proxy-contract-ownership.test.mjs',
    ]) {
      assert.ok(section.groups.body.includes(requiredText), `proxy contract omits ${requiredText}`);
    }
  });

  it('derives the allowed model and revision from the canonical local model contract', () => {
    const sourceFile = parse(sharedContractSource, 'hf-proxy-contract.ts');
    const imports = namedImportsFrom(
      sourceFile,
      '@brainstrike/assistant-contract/local-llm-model-specs'
    );
    assert.ok(imports.has('GEMMA4_E2B_MODEL_ID'));
    assert.ok(imports.has('GEMMA4_E2B_REVISION'));

    const literals = stringLiteralsIn(sourceFile);
    assert.ok(!literals.has('onnx-community/gemma-4-E2B-it-ONNX'));
    assert.ok(!literals.has('30b3854c1ca3e0f08981e1a439de9fbd9245a3a9'));
  });

  for (const [name, source, expectedImports] of [
    ['development proxy', devProxySource, commonSharedConstantNames],
    [
      'production proxy',
      productionProxySource,
      [...commonSharedConstantNames, 'ALLOWED_MODEL_REVISION'],
    ],
  ]) {
    it(`${name} imports the shared constants without inlining their values`, () => {
      const sourceFile = parse(source, `${name}.ts`);
      const imports = namedImportsFrom(sourceFile, 'hf-proxy-contract');
      for (const constantName of expectedImports) {
        assert.ok(imports.has(constantName), `${name} does not import ${constantName}`);
      }

      const literals = stringLiteralsIn(sourceFile);
      for (const literal of forbiddenProxyLiterals) {
        assert.ok(!literals.has(literal), `${name} inlines ${literal}`);
      }
    });
  }
});
