import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostedOutputs = [
  'dist/hosted-web.js',
  'dist/hosted-web.mjs',
  'dist/request-boundary.js',
  'dist/request-boundary.mjs',
];
const forbiddenRuntimeImports = [
  {
    label: '@brainstrike/assistant-contract runtime import',
    pattern:
      /(?:from\s+|require\()['"]@brainstrike\/assistant-contract(?:\/[^'"]*)?['"]/u,
  },
  {
    label: 'Hugging Face runtime import',
    pattern: /['"]@huggingface\/transformers['"]/u,
  },
  {
    label: 'ONNX runtime import',
    pattern: /['"]onnxruntime(?:-node|-web)?['"]/u,
  },
];

for (const relativePath of hostedOutputs) {
  const outputPath = path.join(packageRoot, relativePath);
  const source = await readFile(outputPath, 'utf8');
  for (const forbidden of forbiddenRuntimeImports) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`${relativePath} contains a forbidden ${forbidden.label}.`);
    }
  }
}

console.log('Hosted Web agent bundles are self-contained and server-safe.');
