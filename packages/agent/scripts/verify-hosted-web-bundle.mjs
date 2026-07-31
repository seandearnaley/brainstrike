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
    pattern: /(?:from\s+|require\()['"]@brainstrike\/assistant-contract(?:\/[^'"]*)?['"]/u,
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

// tsup INLINES the contract into these bundles (noExternal), so the specifier
// check above cannot see what actually got bundled. Today even a contract
// ROOT-barrel import stays clean because esbuild treeshakes the unused
// `export *` graph — but that guarantee is implicit and fragile: one
// side-effectful module anywhere in the barrel (or a DCE regression) would
// silently bundle the heavy implementation bodies with no specifier left to
// match (BST-977). These sentinels are top-level names from those bodies; the
// bundles are not minified, so bundling any of them makes the name appear
// verbatim. Control-tested by appending a sentinel to dist and watching this
// script fail.
const forbiddenBundledSymbols = [
  { label: 'local-runtime discovery service body', pattern: /\bLocalRuntimeDiscoveryService\b/u },
  {
    label: 'local-runtime model-catalog service body',
    pattern: /\bLocalRuntimeModelCatalogService\b/u,
  },
  { label: 'tool-schema display table body', pattern: /\bNATIVE_TOOL_SCHEMAS\b/u },
];

for (const relativePath of hostedOutputs) {
  const outputPath = path.join(packageRoot, relativePath);
  const source = await readFile(outputPath, 'utf8');
  for (const forbidden of forbiddenRuntimeImports) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`${relativePath} contains a forbidden ${forbidden.label}.`);
    }
  }
  for (const forbidden of forbiddenBundledSymbols) {
    if (forbidden.pattern.test(source)) {
      throw new Error(
        `${relativePath} bundles a forbidden ${forbidden.label} — a contract ROOT-barrel import has likely returned (import the precise subpath instead).`
      );
    }
  }
}

console.log('Hosted Web agent bundles are self-contained and server-safe.');
