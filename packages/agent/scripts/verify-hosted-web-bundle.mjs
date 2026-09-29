import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostedOutputs = [
  'dist/hosted-web.js',
  'dist/hosted-web.mjs',
  'dist/request-boundary.js',
  'dist/request-boundary.mjs',
];
const mcpFreeOutputs = [
  ...hostedOutputs,
  ...['browser-safe', 'index'].flatMap((entry) => [`dist/${entry}.js`, `dist/${entry}.mjs`]),
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

const requireFromAgent = createRequire(path.join(packageRoot, 'package.json'));

/**
 * The manifest of a required package.
 *
 * Resolved by walking up from the package's ENTRY file rather than by resolving
 * `<specifier>/package.json`, because a package with an `exports` map need not
 * expose its own manifest as a subpath — `@brainstrike/types` does not, and an
 * earlier version of this check resolved that throw into "assume it is fine",
 * which made the whole comparison pass vacuously on the exact package that
 * prompted it. Failure to locate a manifest now THROWS: an unreadable package
 * must fail the build, never quietly count as safe.
 */
function readPackageManifest(specifier) {
  let directory = path.dirname(requireFromAgent.resolve(specifier));
  while (true) {
    const candidate = path.join(directory, 'package.json');
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
      if (manifest.name === specifier) {
        return manifest;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(
        `verify-hosted-web-bundle could not locate the package manifest for ${specifier}; resolve this rather than skipping the package.`
      );
    }
    directory = parent;
  }
}

/**
 * Whether `require(specifier)` resolves to something Node can actually load as
 * CommonJS. Read from the resolved manifest rather than assumed: a package is
 * requireable when it is not `type: module`, or when its `require` condition
 * points at an explicit `.cjs` file.
 */
function isRequireable(specifier) {
  const manifest = readPackageManifest(specifier);
  if (manifest.type !== 'module') {
    return true;
  }
  const requireTarget = manifest.exports?.['.']?.require ?? manifest.main;
  return typeof requireTarget === 'string' && requireTarget.endsWith('.cjs');
}

/**
 * The compatibility CJS outputs must not require ESM-only workspace packages.
 * Hosted functions select native ESM, checked by the actual load probe below;
 * retaining unsafe workspace requires in the compatibility output would hide
 * module-boundary regressions from consumers with stricter loaders.
 */
function collectEsmOnlyRequires(source) {
  // Reduced to the package name: `require("@brainstrike/utils/string-utils")`
  // and `require("@brainstrike/utils")` are the same package, and it is the
  // package manifest that decides whether either can be loaded as CommonJS.
  const packageNames = new Set(
    [...source.matchAll(/require\(["'](?<specifier>@brainstrike\/[^"']+)["']\)/gu)].map((match) =>
      match.groups.specifier.split('/').slice(0, 2).join('/')
    )
  );
  return [...packageNames].filter((packageName) => !isRequireable(packageName)).sort();
}

for (const relativePath of hostedOutputs) {
  const outputPath = path.join(packageRoot, relativePath);
  const source = await readFile(outputPath, 'utf8');
  if (relativePath.endsWith('.mjs')) {
    // Hosted functions use ESM and must load without require(ESM) support.
    execFileSync(
      process.execPath,
      [
        '--no-experimental-require-module',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(outputPath).href)})`,
      ],
      { encoding: 'utf8', killSignal: 'SIGKILL', timeout: 30_000 }
    );
  }
  if (relativePath.endsWith('.js')) {
    const esmOnlyRequires = collectEsmOnlyRequires(source);
    if (esmOnlyRequires.length > 0) {
      throw new Error(
        `${relativePath} requires ESM-only package(s) ${esmOnlyRequires.join(', ')}; the CJS Hosted Web function would throw ERR_REQUIRE_ESM on load. Add them to the hosted \`noExternal\` in tsup.config.ts so they are bundled.`
      );
    }
  }
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

for (const relativePath of mcpFreeOutputs) {
  const source = await readFile(path.join(packageRoot, relativePath), 'utf8');
  if (/@modelcontextprotocol\//u.test(source) || /\bStdioClientTransport\b/u.test(source)) {
    throw new Error(
      `${relativePath} contains the Node-only MCP SDK client; only the dedicated mcp-client entry may own that runtime.`
    );
  }
}

console.log('Hosted Web agent bundles are self-contained and server-safe.');
