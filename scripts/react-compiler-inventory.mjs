#!/usr/bin/env node
/**
 * React Compiler compiled-versus-bailed inventory (BST-1659).
 *
 * `compilationMode: 'infer'` silently skips every function it cannot analyse, so a large
 * component can lose auto-memoization entirely without a single build warning. This script
 * makes that visible, and makes it comparable across compiler backends.
 *
 * The measurement is the same for both backends: compile a module, then read the emitted
 * code and record every function that received a `react/compiler-runtime` cache slot. That
 * is exactly "did this function get auto-memoized".
 *
 * The Babel backend additionally exposes a per-function event logger, so it can name the
 * functions the compiler ATTEMPTED and failed, with the reason. `oxc-transform-react`
 * (0.148.0) has no equivalent: its `TransformResult` carries only fatal `errors`, which stay
 * empty for ordinary bailouts. The oxc report therefore declares
 * `bailoutReasonsSupported: false` rather than reporting an empty bailout list as if it
 * were an absence of bailouts.
 *
 * Usage:
 *   node scripts/react-compiler-inventory.mjs --backend <babel|oxc> --out <file.json>
 *   node scripts/react-compiler-inventory.mjs --diff <baseline.json> <candidate.json>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync as babelTransformSync, parseSync, traverse } from '@babel/core';
import { transformSync as oxcTransformSync } from 'oxc-transform-react';

export const BACKENDS = ['babel', 'oxc'];

/** Mirrors `ReactCompilerConfig` in apps/web/vite.config.mts and apps/desktop/vite.config.mts. */
export const COMPILATION_MODE = 'infer';

const COMPILER_RUNTIME_MODULE = 'react/compiler-runtime';
const BASE_PARSER_PLUGINS = ['typescript', 'explicitResourceManagement'];

/**
 * `<T>(x: T) => x` is a type-parameter list in `.ts` and an unterminated JSX tag in `.tsx`, so
 * the JSX parser plugin must be scoped to the extensions that actually carry JSX. Enabling it
 * everywhere silently drops every `.ts` module holding a generic arrow from the inventory.
 */
function parserPluginsFor(filename) {
  return /\.(?:tsx|jsx)$/u.test(filename) ? [...BASE_PARSER_PLUGINS, 'jsx'] : BASE_PARSER_PLUGINS;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Source roots the two app bundles feed through the React Compiler. The Vite `babel()` plugin
 * excludes only `node_modules` and `.vite`, so every first-party module in the graph is a
 * candidate.
 */
export const SOURCE_ROOTS = ['apps/web/src', 'apps/desktop/src/renderer', 'packages'];

/** Logger events that mean "the compiler attempted this function and gave up". */
const BAILOUT_EVENT_KINDS = new Set(['CompileError', 'CompileSkip', 'PipelineError']);

const SKIPPED_DIRECTORIES = new Set(['__mocks__', '__tests__', 'dist', 'e2e', 'node_modules']);

function langForFilename(filename) {
  const extension = path.extname(filename);
  if (extension === '.tsx') {
    return 'tsx';
  }
  if (extension === '.ts') {
    return 'ts';
  }
  if (extension === '.jsx') {
    return 'jsx';
  }
  if (extension === '.js' || extension === '.mjs') {
    return 'js';
  }
  throw new Error(`Unsupported source extension for React Compiler inventory: ${filename}`);
}

function parse(code, filename) {
  return parseSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    parserOpts: { errorRecovery: false, plugins: parserPluginsFor(filename) },
    sourceType: 'module',
  });
}

/** The name the compiler output attributes a function to, mirroring how `infer` names them. */
function inferFunctionName(nodePath) {
  if (nodePath.node.id?.name) {
    return nodePath.node.id.name;
  }
  let current = nodePath.parentPath;
  while (current) {
    const node = current.node;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      return node.id.name;
    }
    if (
      (node.type === 'ObjectProperty' ||
        node.type === 'ObjectMethod' ||
        node.type === 'ClassMethod' ||
        node.type === 'ClassProperty') &&
      node.key?.type === 'Identifier'
    ) {
      return node.key.name;
    }
    if (
      node.type === 'CallExpression' ||
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'ParenthesizedExpression'
    ) {
      current = current.parentPath;
      continue;
    }
    return null;
  }
  return null;
}

function findCompilerRuntimeBinding(ast) {
  for (const statement of ast.program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.source.value !== COMPILER_RUNTIME_MODULE
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'c') {
        return specifier.local.name;
      }
    }
  }
  return null;
}

/** `const $ = _c(N);` near the top of a compiled function body. */
function readCacheSlotCount(functionNode, bindingName) {
  const body = functionNode.body;
  if (body?.type !== 'BlockStatement') {
    return null;
  }
  for (const statement of body.body) {
    if (statement.type !== 'VariableDeclaration') {
      continue;
    }
    for (const declarator of statement.declarations) {
      const init = declarator.init;
      if (
        init?.type === 'CallExpression' &&
        init.callee.type === 'Identifier' &&
        init.callee.name === bindingName &&
        init.arguments[0]?.type === 'NumericLiteral'
      ) {
        return init.arguments[0].value;
      }
    }
  }
  return null;
}

/**
 * Every function in `code` that owns a `react/compiler-runtime` cache slot — i.e. every
 * function the React Compiler actually memoized.
 */
export function collectCompiledFunctions(code, filename = 'output.tsx') {
  const ast = parse(code, filename);
  const bindingName = findCompilerRuntimeBinding(ast);
  if (bindingName === null) {
    return [];
  }

  const compiled = [];
  traverse(ast, {
    Function(nodePath) {
      const memoSlots = readCacheSlotCount(nodePath.node, bindingName);
      if (memoSlots === null) {
        return;
      }
      compiled.push({
        memoSlots,
        name: inferFunctionName(nodePath) ?? `(anonymous)@${nodePath.node.loc?.start.line ?? 0}`,
      });
    },
  });
  return compiled;
}

/** Source-side function positions, used to attach source lines and to name bailouts. */
function indexSourceFunctions(source, filename) {
  const ast = parse(source, filename);
  const byLocation = new Map();
  const byName = new Map();
  const duplicateNames = new Set();

  traverse(ast, {
    Function(nodePath) {
      const loc = nodePath.node.loc;
      if (!loc) {
        return;
      }
      const name = inferFunctionName(nodePath);
      const entry = { column: loc.start.column, line: loc.start.line, name };
      byLocation.set(`${loc.start.line}:${loc.start.column}`, entry);
      if (name === null) {
        return;
      }
      if (byName.has(name)) {
        duplicateNames.add(name);
        return;
      }
      byName.set(name, entry);
    },
  });

  return { byLocation, byName, duplicateNames };
}

function describeBailout(event) {
  if (event.kind === 'CompileSkip') {
    return {
      column: event.loc?.start.column ?? null,
      line: event.loc?.start.line ?? null,
      reason: event.reason,
    };
  }
  if (event.kind === 'PipelineError') {
    return { column: null, line: null, reason: event.data };
  }
  const detail = event.detail;
  const options = detail?.options ?? detail;
  const reason = options?.reason ?? options?.description ?? 'unknown compiler error';
  const category = options?.category ? `${options.category}: ` : '';
  return {
    column: options?.loc?.start?.column ?? null,
    line: options?.loc?.start?.line ?? null,
    reason: `${category}${reason}`,
  };
}

function runBabel(filename, source) {
  const events = [];
  const result = babelTransformSync(source, {
    babelrc: false,
    configFile: false,
    filename,
    parserOpts: { plugins: parserPluginsFor(filename) },
    plugins: [
      [
        'babel-plugin-react-compiler',
        {
          compilationMode: COMPILATION_MODE,
          logger: {
            logEvent: (_filename, event) => {
              events.push(event);
            },
          },
          panicThreshold: 'none',
        },
      ],
    ],
    sourceType: 'module',
  });
  if (result?.code === undefined || result.code === null) {
    throw new Error(`Babel produced no output for ${filename}`);
  }
  return { code: result.code, events };
}

function runOxc(filename, source) {
  const result = oxcTransformSync(filename, source, {
    jsx: { runtime: 'automatic' },
    lang: langForFilename(filename),
    reactCompiler: { compilationMode: COMPILATION_MODE, panicThreshold: 'none' },
    sourceType: 'module',
  });
  const fatal = result.errors.filter((error) => error.severity === 'Error');
  if (result.fatal || fatal.length > 0) {
    throw new Error(
      `oxc-transform-react failed on ${filename}: ${fatal.map((error) => error.message).join('; ')}`
    );
  }
  return { code: result.code };
}

/** Inventory a single module. Throws on an unknown backend — never guesses one. */
export function inventorySource({ backend, filename, source }) {
  if (!BACKENDS.includes(backend)) {
    throw new Error(
      `Unknown React Compiler backend "${backend}". Expected one of: ${BACKENDS.join(', ')}.`
    );
  }

  const sourceFunctions = indexSourceFunctions(source, filename);
  const functions = [];

  const { code, events } =
    backend === 'babel' ? runBabel(filename, source) : runOxc(filename, source);

  for (const compiled of collectCompiledFunctions(code, filename)) {
    const position = sourceFunctions.byName.get(compiled.name);
    functions.push({
      ambiguousName: sourceFunctions.duplicateNames.has(compiled.name),
      line: position?.line ?? null,
      memoSlots: compiled.memoSlots,
      name: compiled.name,
      status: 'compiled',
    });
  }

  if (backend === 'babel') {
    // The compiler logs one CompileError per failing site, so a single function can raise
    // many. The inventory unit is the FUNCTION: group the events and keep every distinct
    // site on that one record.
    const bailouts = new Map();
    for (const event of events ?? []) {
      if (!BAILOUT_EVENT_KINDS.has(event.kind)) {
        continue;
      }
      const start = event.fnLoc?.start;
      const named = start
        ? sourceFunctions.byLocation.get(`${start.line}:${start.column}`)
        : undefined;
      const name = named?.name ?? `(anonymous)@${start?.line ?? 0}`;
      const key = `${name}@${start?.line ?? 0}:${start?.column ?? 0}`;
      const existing = bailouts.get(key);
      const record = existing ?? {
        ambiguousName: named?.name ? sourceFunctions.duplicateNames.has(named.name) : false,
        line: start?.line ?? null,
        name,
        reasons: [],
        status: 'bailed',
      };
      const site = describeBailout(event);
      const duplicate = record.reasons.some(
        (entry) =>
          entry.reason === site.reason && entry.line === site.line && entry.column === site.column
      );
      if (!duplicate) {
        record.reasons.push(site);
      }
      if (!existing) {
        bailouts.set(key, record);
      }
    }
    functions.push(...bailouts.values());
  }

  return {
    backend,
    bailoutReasonsSupported: backend === 'babel',
    filename,
    functions,
  };
}

function* walkSourceFiles(absoluteRoot) {
  if (!existsSync(absoluteRoot)) {
    return;
  }
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    const absolute = path.join(absoluteRoot, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      yield* walkSourceFiles(absolute);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!/\.(?:tsx|ts)$/u.test(entry.name)) {
      continue;
    }
    if (/\.d\.ts$/u.test(entry.name) || /\.(?:test|spec|bench)\./u.test(entry.name)) {
      continue;
    }
    yield absolute;
  }
}

export function collectSourceFiles(repoRoot = REPO_ROOT, roots = SOURCE_ROOTS) {
  const files = [];
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (root === 'packages') {
      for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        files.push(...walkSourceFiles(path.join(absoluteRoot, entry.name, 'src')));
      }
      continue;
    }
    files.push(...walkSourceFiles(absoluteRoot));
  }
  return files.map((file) => path.relative(repoRoot, file)).sort();
}

export function buildInventory({ backend, repoRoot = REPO_ROOT, onProgress }) {
  const files = collectSourceFiles(repoRoot);
  const functions = [];
  const failures = [];
  let bailoutReasonsSupported = true;
  let scanned = 0;

  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    const source = readFileSync(absolute, 'utf8');
    try {
      const report = inventorySource({ backend, filename: absolute, source });
      bailoutReasonsSupported = report.bailoutReasonsSupported;
      for (const entry of report.functions) {
        functions.push({ file, ...entry });
      }
    } catch (error) {
      failures.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
    scanned += 1;
    onProgress?.(scanned, files.length, file);
  }

  functions.sort((a, b) =>
    a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)
  );

  return {
    backend,
    bailoutReasonsSupported,
    compilationMode: COMPILATION_MODE,
    failures,
    fileCount: files.length,
    functions,
    summary: {
      bailed: functions.filter((entry) => entry.status === 'bailed').length,
      compiled: functions.filter((entry) => entry.status === 'compiled').length,
    },
  };
}

function compiledKeys(inventory) {
  const keys = new Map();
  for (const entry of inventory.functions) {
    if (entry.status !== 'compiled') {
      continue;
    }
    keys.set(`${entry.file}::${entry.name}`, entry);
  }
  return keys;
}

/** Regressions are functions that compiled in `baseline` and no longer compile in `candidate`. */
export function diffInventories(baseline, candidate) {
  const before = compiledKeys(baseline);
  const after = compiledKeys(candidate);

  const regressions = [];
  const wins = [];
  const stillBailed = [];
  let unchanged = 0;

  for (const [key, entry] of before) {
    if (after.has(key)) {
      unchanged += 1;
      continue;
    }
    regressions.push({ key, ...entry });
  }
  for (const [key, entry] of after) {
    if (!before.has(key)) {
      wins.push({ key, ...entry });
    }
  }
  for (const entry of baseline.functions) {
    const key = `${entry.file}::${entry.name}`;
    if (entry.status === 'bailed' && !after.has(key)) {
      stillBailed.push({ key, ...entry });
    }
  }

  return {
    baselineBackend: baseline.backend,
    candidateBackend: candidate.backend,
    regressions,
    stillBailed,
    unchanged,
    wins,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), 'utf8'));
}

function writeJson(file, value) {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function requireFlag(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1 || argv[index + 1] === undefined) {
    throw new Error(`Missing required ${flag} <value>`);
  }
  return argv[index + 1];
}

async function main(argv) {
  if (argv.includes('--diff')) {
    const index = argv.indexOf('--diff');
    const baselineFile = argv[index + 1];
    const candidateFile = argv[index + 2];
    if (!(baselineFile && candidateFile)) {
      throw new Error('Usage: --diff <baseline.json> <candidate.json>');
    }
    const diff = diffInventories(readJson(baselineFile), readJson(candidateFile));
    process.stdout.write(
      `${diff.baselineBackend} -> ${diff.candidateBackend}: ` +
        `${diff.unchanged} still compiled, ${diff.wins.length} newly compiled, ` +
        `${diff.regressions.length} regressed\n`
    );
    for (const entry of diff.wins) {
      process.stdout.write(`  + ${entry.key}\n`);
    }
    for (const entry of diff.regressions) {
      process.stdout.write(`  - ${entry.key} (line ${entry.line ?? '?'})\n`);
    }
    process.stdout.write(
      `${diff.stillBailed.length} function(s) bailed under ${diff.baselineBackend} and are ` +
        `still not memoized under ${diff.candidateBackend}\n`
    );
    if (diff.regressions.length > 0) {
      throw new Error(`${diff.regressions.length} function(s) regressed from compiled to bailed`);
    }
    return;
  }

  const backend = requireFlag(argv, '--backend');
  const out = requireFlag(argv, '--out');
  const started = Date.now();
  const inventory = buildInventory({
    backend,
    onProgress: (scanned, total) => {
      if (scanned % 250 === 0 || scanned === total) {
        process.stderr.write(`  ${scanned}/${total} files\n`);
      }
    },
  });
  inventory.elapsedMs = Date.now() - started;
  writeJson(out, inventory);
  process.stdout.write(
    `${backend}: ${inventory.fileCount} files, ${inventory.summary.compiled} compiled, ` +
      `${inventory.summary.bailed} bailed, ${inventory.failures.length} failed to analyse ` +
      `(${inventory.elapsedMs}ms) -> ${out}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
