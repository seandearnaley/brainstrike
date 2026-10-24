/**
 * Post-build contract (BST-2148): no Node-side desktop entry may load
 * Transformers.js or onnxruntime-node.
 *
 * Local inference runs in hidden renderer hosts on Transformers.js's web build
 * (onnxruntime-web; ADR 0007). Its Node build loads onnxruntime-node when it is
 * imported, and onnxruntime-node 1.24.1+ ships no darwin-x64 binding, so the
 * packaged app leaves that package out (package.json `build.files`). A Node-side
 * import would pass in development and fail only in the packaged app.
 *
 * The walk follows each entry the way Node resolves it: `node` plus the import's
 * own `import`/`require` condition, `main` without `exports`, through
 * node_modules and literal dynamic imports. A first-party module that names a
 * `.js`/`.mjs`/`.cjs` file in `new URL(...)` (a worker or process entry) adds
 * that file as a root. Each build's own metafile also joins the graph, so modules
 * a self-bundled entry inlined are seen too. `build-main.mjs` runs it once, on
 * every Node build it emits; `src/__tests__/node-inference-boundary.test.ts` pins
 * it on fixtures.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const NODE_FORBIDDEN_PACKAGES = ['@huggingface/transformers', 'onnxruntime-node'];

// Every file esbuild parses as code is followed, so the walk never stops at source.
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/u;
const EMITTED_MODULE = /\.(?:c|m)?js$/u;
const URL_NAMED_MODULE = /\bnew URL\(\s*(['"])([^'"]+?\.(?:c|m)?js)\1/gu;
const RESOLVING = Symbol('node-inference-boundary.resolving');

/**
 * @typedef {import('esbuild').Metafile} Metafile
 * @typedef {Metafile['inputs']} MetafileInputs
 * @typedef {{ external?: boolean, kind: string, original?: string, path: string }} ImportEdge
 */

/** @param {string} target */
function forbiddenPackageOf(target) {
  return (
    NODE_FORBIDDEN_PACKAGES.find(
      (name) =>
        target === name || target.startsWith(`${name}/`) || target.includes(`node_modules/${name}/`)
    ) ?? null
  );
}

/**
 * Resolve bare specifiers as Node would; stop at forbidden packages, builtins and addons.
 * @type {import('esbuild').Plugin}
 */
const nodeRuntimeResolution = {
  name: 'node-runtime-resolution',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({ external: true, path: args.path }));
    pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData?.[RESOLVING]) {
        return;
      }
      if (args.path === 'electron' || isBuiltin(args.path) || forbiddenPackageOf(args.path)) {
        return { external: true, path: args.path };
      }
      const result = await pluginBuild.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        pluginData: { [RESOLVING]: true },
        resolveDir: args.resolveDir,
      });
      // An unresolvable bare require (ws's optional bufferutil) throws at runtime, and its
      // owner catches it; a resolved asset (`.wasm?url`) is data. Neither imports further.
      if (result.errors.length > 0 || !SOURCE_FILE.test(result.path)) {
        return { external: true, path: result.path || args.path };
      }
      return result;
    });
  },
};

/**
 * @param {string} absWorkingDir
 * @param {string[]} entryPoints
 * @returns {Promise<MetafileInputs>}
 */
async function walk(absWorkingDir, entryPoints) {
  const { metafile } = await build({
    absWorkingDir,
    bundle: true,
    // No bundler-only `module` condition: `node`, `default` and the import's own kind.
    conditions: [],
    // Never written; hashed names keep same-named entries (writer-worker.js and
    // writer-worker.mjs) from colliding in the analysis output.
    entryNames: '[name]-[hash]',
    entryPoints,
    format: 'esm',
    logLevel: 'silent',
    mainFields: ['main'],
    metafile: true,
    outdir: path.join(absWorkingDir, '.node-inference-boundary'),
    platform: 'node',
    plugins: [nodeRuntimeResolution],
    // Node applies no tsconfig `paths`.
    tsconfigRaw: '{}',
    write: false,
  });
  return metafile.inputs;
}

/**
 * First-party modules named by `new URL('<file>.js', …)` in `inputs`, keyed by the naming module.
 * @param {string} absWorkingDir
 * @param {MetafileInputs} inputs
 */
function urlNamedModules(absWorkingDir, inputs) {
  /** @type {Map<string, string>} */
  const named = new Map();
  for (const input of Object.keys(inputs)) {
    if (input.includes('node_modules/')) {
      continue;
    }
    const file = path.resolve(absWorkingDir, input);
    for (const [, , namedFile] of readFileSync(file, 'utf8').matchAll(URL_NAMED_MODULE)) {
      if (namedFile === undefined) {
        continue;
      }
      const target = path.resolve(path.dirname(file), namedFile);
      const key = path.relative(absWorkingDir, target).split(path.sep).join('/');
      if (existsSync(target) && !named.has(key)) {
        named.set(key, input);
      }
    }
  }
  return named;
}

/**
 * Adds `more` to `inputs`, keeping every import a module has in either graph.
 * @param {MetafileInputs} inputs
 * @param {MetafileInputs} more
 */
function mergeInputs(inputs, more) {
  for (const [file, input] of Object.entries(more)) {
    const known = inputs[file];
    inputs[file] = known ? { ...known, imports: [...known.imports, ...input.imports] } : input;
  }
}

/**
 * Every chain from the given builds to a forbidden package, as
 * `root -[kind]-> module ... -[kind]-> 'package'`. Empty when none is reachable.
 * `builds` are esbuild metafiles, paths relative to `absWorkingDir`. Each one gives
 * its own record of what it bundled, from its source entries, and its emitted files,
 * walked as Node loads them. A self-bundled entry inlines its packages, so its
 * emitted file alone hides what it carries.
 * @param {{ absWorkingDir: string, builds: readonly Metafile[] }} options
 * @returns {Promise<string[]>}
 */
export async function findNodeInferenceImports({ absWorkingDir: workingDir, builds }) {
  // esbuild keys the metafile by real paths (macOS tmpdir is a symlink).
  const absWorkingDir = realpathSync(workingDir);
  const outputs = builds.flatMap((metafile) => Object.entries(metafile.outputs));
  const emitted = outputs.map(([file]) => file).filter((file) => EMITTED_MODULE.test(file));
  const entryPoints = [
    ...new Set([...emitted, ...outputs.flatMap(([, output]) => output.entryPoint ?? [])]),
  ];
  /** @type {Map<string, string | null>} */
  const roots = new Map(entryPoints.map((entry) => [entry, null]));
  const inputs = await walk(absWorkingDir, emitted);
  for (const metafile of builds) {
    mergeInputs(inputs, metafile.inputs);
  }
  for (;;) {
    const added = [...urlNamedModules(absWorkingDir, inputs)].filter(([key]) => !roots.has(key));
    if (added.length === 0) {
      break;
    }
    for (const [key, namer] of added) {
      roots.set(key, namer);
    }
    mergeInputs(
      inputs,
      await walk(
        absWorkingDir,
        added.map(([key]) => key)
      )
    );
  }

  // Breadth-first from the declared entries, so each chain is a shortest one.
  /** @type {Map<string, { from: string, kind: string } | null>} */
  const parent = new Map(entryPoints.map((entry) => [entry, null]));
  const queue = [...entryPoints];
  /** @type {string[]} */
  const chains = [];
  /** @param {string} node */
  const label = (node) => {
    const steps = [node];
    for (let step = parent.get(node); step; step = parent.get(step.from)) {
      steps.unshift(`${step.from} -[${step.kind}]->`);
    }
    return steps.join(' ');
  };
  // The iterator visits each module the loop appends, in order.
  for (const current of queue) {
    /** @type {ImportEdge[]} */
    const edges = [
      ...(inputs[current]?.imports ?? []),
      ...[...roots]
        .filter(([, namer]) => namer === current)
        .map(([key]) => ({ kind: 'new-url', path: key })),
    ];
    for (const edge of edges) {
      if (forbiddenPackageOf(edge.path)) {
        chains.push(`${label(current)} -[${edge.kind}]-> '${edge.original ?? edge.path}'`);
        continue;
      }
      if (edge.external || parent.has(edge.path)) {
        continue;
      }
      parent.set(edge.path, { from: current, kind: edge.kind });
      queue.push(edge.path);
    }
  }
  return [...new Set(chains)];
}

/** @param {readonly string[]} chains */
export function assertNoNodeInferenceImports(chains) {
  if (chains.length === 0) {
    return;
  }
  throw new Error(
    [
      'Node-side desktop entries reach a package the packaged app does not ship (BST-2148):',
      ...chains.map((chain) => `  ${chain}`),
      'Local inference runs in hidden renderer hosts on the web build (ADR 0007).',
    ].join('\n')
  );
}
