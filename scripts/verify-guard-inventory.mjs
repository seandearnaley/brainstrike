import { realpathSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const INVENTORY_ROW =
  /^(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs)) → wired=(?<wired>yes|no)\/paired=(?<paired>yes|no)\/armed=(?<armed>yes|no) → (?<purpose>\S.*)$/;
const REQUIRED_STATES = ['wired', 'paired', 'armed'];
const GUARD_LEAF_SCRIPT_NAME = /^(?:arch:|boundaries$|coverage:enforce$|lint(?::|$)|secrets:scan$)/;
const DIRECT_NODE_GUARD = /\bnode scripts\/(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs))\b/g;
const PACKAGE_SCRIPT_INVOCATION = /\bpnpm(?:\s+run)?\s+(?<name>[a-z0-9][a-z0-9:-]*)\b/g;
const CONTRACT_TEST = /\bcontract: scripts\/__tests__\/(?<path>[a-z0-9][a-z0-9.-]*\.test\.mjs)\b/;
const REQUIRED_PATH_CHANNEL = /\bchannel: required-path\b/;
const INVENTORY_LABEL = 'scripts/_guard-inventory.md';
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_ROOT_GUARD_ENTRYPOINTS = ['coverage:enforce', 'lint'];
const REQUIRED_WORKFLOW_PACKAGE_SCRIPTS = ['lint:ci'];
const REQUIRED_WORKFLOW_PATHS = ['.github/workflows/test.yml'];

function collectPackageScriptNames(source) {
  return [...source.matchAll(PACKAGE_SCRIPT_INVOCATION)]
    .map((match) => match.groups?.name)
    .filter(Boolean);
}

function collectDirectGuardScripts(source) {
  return [...source.matchAll(DIRECT_NODE_GUARD)]
    .map((match) => match.groups?.script)
    .filter(Boolean);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStaticallyDisabled(condition) {
  if (condition === false) {
    return true;
  }
  if (typeof condition !== 'string') {
    return false;
  }

  const normalized = condition.trim();
  return /^false$/i.test(normalized) || /^\$\{\{\s*false\s*\}\}$/i.test(normalized);
}

function collectWorkflowRunCommands(source) {
  const workflow = parseYaml(source);
  if (!(isRecord(workflow) && isRecord(workflow.jobs) && isRecord(workflow.jobs.static))) {
    throw new Error('required workflow must define a jobs.static mapping');
  }
  const steps = workflow.jobs.static.steps;
  if (!Array.isArray(steps)) {
    throw new Error('required workflow jobs.static must define a steps array');
  }

  return steps.flatMap((step) => {
    if (!isRecord(step)) {
      throw new Error('required workflow jobs.static steps must be mappings');
    }
    if (isStaticallyDisabled(step.if)) {
      return [];
    }
    return typeof step.run === 'string' ? [step.run] : [];
  });
}

function collectReachablePackageScripts(packageScripts, entrypoints) {
  const reachable = new Set();
  const pending = [...entrypoints];

  while (pending.length > 0) {
    const name = pending.shift();
    if (reachable.has(name) || packageScripts[name] === undefined) {
      continue;
    }

    reachable.add(name);
    pending.push(...collectPackageScriptNames(packageScripts[name]));
  }

  return reachable;
}

function collectRequiredGuardScripts(packageScripts, workflowSources) {
  const workflowEntrypoints = new Set();
  for (const workflowSource of workflowSources) {
    for (const command of collectWorkflowRunCommands(workflowSource)) {
      for (const name of collectPackageScriptNames(command)) {
        if (packageScripts[name] !== undefined) {
          workflowEntrypoints.add(name);
        }
      }
    }
  }

  const workflowReachablePackageScripts = collectReachablePackageScripts(
    packageScripts,
    workflowEntrypoints
  );
  const entrypoints = new Set([
    ...LOCAL_ROOT_GUARD_ENTRYPOINTS,
    ...[...workflowEntrypoints].filter((name) => GUARD_LEAF_SCRIPT_NAME.test(name)),
  ]);
  const reachablePackageScripts = collectReachablePackageScripts(packageScripts, entrypoints);
  const ciRequired = new Set();
  const required = new Set();
  const guardBindings = new Map();

  for (const [name, command] of Object.entries(packageScripts)) {
    const directGuards = collectDirectGuardScripts(command);
    if (reachablePackageScripts.has(name)) {
      for (const script of directGuards) {
        required.add(script);
      }
    }
    if (workflowReachablePackageScripts.has(name)) {
      for (const script of directGuards) {
        ciRequired.add(script);
      }
    }

    if (GUARD_LEAF_SCRIPT_NAME.test(name)) {
      for (const script of directGuards) {
        const bindings = guardBindings.get(script) ?? new Set();
        bindings.add(name);
        guardBindings.set(script, bindings);
      }
    }
  }

  for (const workflowSource of workflowSources) {
    for (const command of collectWorkflowRunCommands(workflowSource)) {
      for (const script of collectDirectGuardScripts(command)) {
        ciRequired.add(script);
        required.add(script);
      }
    }
  }

  const unreachable = new Set();
  for (const [script, bindings] of guardBindings) {
    if ([...bindings].every((name) => !reachablePackageScripts.has(name))) {
      unreachable.add(script);
    }
  }

  const missingWorkflowEntrypoints =
    workflowSources.length === 0
      ? []
      : REQUIRED_WORKFLOW_PACKAGE_SCRIPTS.filter(
          (name) => !workflowReachablePackageScripts.has(name)
        );

  return { ciRequired, missingWorkflowEntrypoints, required, unreachable };
}

export async function loadGuardTestSources(scriptsRoot) {
  const testsRoot = path.join(scriptsRoot, '__tests__');
  const relativePaths = (await readdir(testsRoot)).filter((relativePath) =>
    relativePath.endsWith('.test.mjs')
  );

  return Promise.all(
    relativePaths.map(async (relativePath) => ({
      path: relativePath,
      source: await readFile(path.join(testsRoot, relativePath), 'utf8'),
    }))
  );
}

function structurallyReferencesGuard(source, script) {
  const sourceFile = ts.createSourceFile(
    'guard-contract.test.mjs',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  );

  const importedGuardBindings = new Set();
  const guardNamespaces = new Set();
  const childProcessBindings = new Set();
  const childProcessNamespaces = new Set();
  const assertBindings = new Set();
  const guardPathBindings = new Set();
  const childProcessResults = new Set();
  const supportedChildProcessCalls = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync']);
  const isGuardSpecifier = (node) => ts.isStringLiteralLike(node) && node.text === `../${script}`;

  for (const statement of sourceFile.statements) {
    if (!(ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier))) {
      continue;
    }

    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }

    if (isGuardSpecifier(statement.moduleSpecifier)) {
      if (importClause.name) {
        importedGuardBindings.add(importClause.name.text);
      }
      if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        guardNamespaces.add(importClause.namedBindings.name.text);
      }
      if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          importedGuardBindings.add(element.name.text);
        }
      }
      continue;
    }

    if (statement.moduleSpecifier.text === 'node:child_process') {
      if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        childProcessNamespaces.add(importClause.namedBindings.name.text);
      }
      if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (supportedChildProcessCalls.has(importedName)) {
            childProcessBindings.add(element.name.text);
          }
        }
      }
      continue;
    }

    if (statement.moduleSpecifier.text === 'node:assert/strict') {
      if (importClause.name) {
        assertBindings.add(importClause.name.text);
      }
      if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        assertBindings.add(importClause.namedBindings.name.text);
      }
    }
  }

  const isImportMetaUrl = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta';
  const isExactGuardPath = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'fileURLToPath' &&
    node.arguments.length === 1 &&
    ts.isNewExpression(node.arguments[0]) &&
    ts.isIdentifier(node.arguments[0].expression) &&
    node.arguments[0].expression.text === 'URL' &&
    node.arguments[0].arguments?.length === 2 &&
    isGuardSpecifier(node.arguments[0].arguments[0]) &&
    isImportMetaUrl(node.arguments[0].arguments[1]);

  const collectGuardPaths = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isExactGuardPath(node.initializer)
    ) {
      guardPathBindings.add(node.name.text);
    }
    ts.forEachChild(node, collectGuardPaths);
  };
  collectGuardPaths(sourceFile);

  const isGuardPathReference = (node) =>
    (ts.isIdentifier(node) && guardPathBindings.has(node.text)) || isExactGuardPath(node);
  const isProcessExecPath = (node) =>
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'execPath';
  const isChildProcessCall = (node) => {
    if (!ts.isCallExpression(node)) {
      return false;
    }
    if (ts.isIdentifier(node.expression)) {
      return childProcessBindings.has(node.expression.text);
    }
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      childProcessNamespaces.has(node.expression.expression.text) &&
      supportedChildProcessCalls.has(node.expression.name.text)
    );
  };
  const executesGuard = (node) => {
    const program = node.arguments[0];
    if (program && isGuardPathReference(program)) {
      return true;
    }
    const programArguments = node.arguments[1];
    return Boolean(
      program &&
        isProcessExecPath(program) &&
        programArguments &&
        ts.isArrayLiteralExpression(programArguments) &&
        programArguments.elements[0] &&
        isGuardPathReference(programArguments.elements[0])
    );
  };

  let invokesImportedGuard = false;
  const collectExecutions = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && importedGuardBindings.has(node.expression.text)) {
        invokesImportedGuard = true;
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        guardNamespaces.has(node.expression.expression.text)
      ) {
        invokesImportedGuard = true;
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isChildProcessCall(node.initializer) &&
      executesGuard(node.initializer)
    ) {
      childProcessResults.add(node.name.text);
    }
    ts.forEachChild(node, collectExecutions);
  };
  collectExecutions(sourceFile);

  if (invokesImportedGuard) {
    return true;
  }

  let assertsChildProcessStatus = false;
  const collectAssertions = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      assertBindings.has(node.expression.expression.text) &&
      ['equal', 'strictEqual'].includes(node.expression.name.text) &&
      node.arguments.some(
        (argument) =>
          ts.isPropertyAccessExpression(argument) &&
          argument.name.text === 'status' &&
          ts.isIdentifier(argument.expression) &&
          childProcessResults.has(argument.expression.text)
      )
    ) {
      assertsChildProcessStatus = true;
      return;
    }
    ts.forEachChild(node, collectAssertions);
  };
  collectAssertions(sourceFile);
  return assertsChildProcessStatus;
}

function hasPairedTest(entry, testSources) {
  const basename = entry.script.replace(/\.(?:cjs|mjs)$/, '');
  const contractPath = CONTRACT_TEST.exec(entry.purpose)?.groups?.path;
  return testSources.some((testSource) => {
    const testPath = testSource.path.replaceAll(path.sep, '/');
    const isResolvedTest =
      path.basename(testPath) === `${basename}.test.mjs` || testPath === contractPath;
    return (
      isResolvedTest &&
      typeof testSource.source === 'string' &&
      structurallyReferencesGuard(testSource.source, entry.script)
    );
  });
}

export function parseGuardInventory(source) {
  const entries = [];
  const scripts = new Set();
  const lines = source.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      continue;
    }

    const match = INVENTORY_ROW.exec(line);
    if (!match?.groups) {
      throw new Error(
        `${INVENTORY_LABEL}:${index + 1} must match "<guard>.<cjs|mjs> → wired=<yes|no>/paired=<yes|no>/armed=<yes|no> → <purpose>"`
      );
    }

    const { armed, paired, purpose, script, wired } = match.groups;
    if (scripts.has(script)) {
      throw new Error(`${INVENTORY_LABEL}:${index + 1} contains duplicate guard ${script}`);
    }
    if (armed === 'yes' && paired === 'no') {
      throw new Error(`${INVENTORY_LABEL}:${index + 1} armed=yes requires paired=yes`);
    }

    scripts.add(script);
    entries.push({
      purpose,
      script,
      states: { armed: armed === 'yes', paired: paired === 'yes', wired: wired === 'yes' },
    });
  }

  if (entries.length === 0) {
    throw new Error('guard inventory must classify at least one guard');
  }

  return entries;
}

export async function validateGuardInventory({
  inventorySource,
  packageScripts,
  scriptsRoot,
  testSources,
  workflowSources = [],
}) {
  const entries = parseGuardInventory(inventorySource);
  const issues = [];
  const inventoryScripts = new Set(entries.map((entry) => entry.script));

  const { ciRequired, missingWorkflowEntrypoints, required, unreachable } =
    collectRequiredGuardScripts(packageScripts, workflowSources);
  for (const name of missingWorkflowEntrypoints) {
    issues.push(
      `${name}: required package-script entrypoint is not reachable from required workflow commands`
    );
  }
  for (const requiredScript of [...required].sort()) {
    if (!inventoryScripts.has(requiredScript)) {
      issues.push(
        `${requiredScript}: required root guard script is missing from ${INVENTORY_LABEL}`
      );
    }
  }

  for (const unreachableScript of [...unreachable].sort()) {
    if (inventoryScripts.has(unreachableScript)) {
      issues.push(
        `${unreachableScript}: wired guard leaf is not reachable from a required root entrypoint`
      );
    }
  }

  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (previous.script > current.script) {
      issues.push(
        `guard inventory rows must use deterministic script-name order: ${current.script} before ${previous.script}`
      );
    }
  }

  for (const entry of entries) {
    if (REQUIRED_PATH_CHANNEL.test(entry.purpose) && !ciRequired.has(entry.script)) {
      issues.push(
        `${entry.script}: declared required-path channel is not reachable from a required CI workflow`
      );
    }
  }

  for (const entry of entries) {
    try {
      await access(path.join(scriptsRoot, entry.script));
    } catch {
      issues.push(`${entry.script}: classified guard script does not exist`);
    }

    if (entry.states.paired && !hasPairedTest(entry, testSources)) {
      issues.push(`${entry.script}: paired guard has no discoverable test under scripts/__tests__`);
    }

    const degradedStates = REQUIRED_STATES.filter((state) => !entry.states[state]);
    if (degradedStates.length > 0) {
      issues.push(
        `${entry.script}: degraded guard state (${degradedStates
          .map((state) => `${state}=no`)
          .join(', ')})`
      );
    }
  }

  return issues;
}

export async function main({ repoRoot = path.resolve(process.argv[2] ?? DEFAULT_REPO_ROOT) } = {}) {
  const scriptsRoot = path.join(repoRoot, 'scripts');
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const inventorySource = await readFile(path.join(scriptsRoot, '_guard-inventory.md'), 'utf8');
  const issues = await validateGuardInventory({
    inventorySource,
    packageScripts: packageJson.scripts,
    scriptsRoot,
    testSources: await loadGuardTestSources(scriptsRoot),
    workflowSources: await Promise.all(
      REQUIRED_WORKFLOW_PATHS.map((relativePath) =>
        readFile(path.join(repoRoot, relativePath), 'utf8')
      )
    ),
  });

  if (issues.length > 0) {
    console.error('Warden guard inventory verification failed:');
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Warden guard inventory verification passed.');
}

const isDirectExecution =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error) => {
    console.error('Warden guard inventory verification failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
