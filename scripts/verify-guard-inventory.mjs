import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVENTORY_ROW =
  /^(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs)) → (?<states>[a-z]+(?:\/[a-z]+)*) → (?<purpose>\S.*)$/;
const REQUIRED_STATES = ['wired', 'paired', 'armed'];
const GUARD_LEAF_SCRIPT_NAME = /^(?:arch:|boundaries$|coverage:enforce$|lint(?::|$)|secrets:scan$)/;
const DIRECT_NODE_GUARD = /\bnode scripts\/(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs))\b/g;
const PACKAGE_SCRIPT_INVOCATION = /\bpnpm(?:\s+run)?\s+(?<name>[a-z0-9][a-z0-9:-]*)\b/g;
const CONTRACT_TEST = /\bcontract: scripts\/__tests__\/(?<path>[a-z0-9][a-z0-9.-]*\.test\.mjs)\b/;
const INVENTORY_LABEL = 'scripts/_guard-inventory.md';
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOT_GUARD_ENTRYPOINTS = ['coverage:enforce', 'lint', 'lint:ci'];
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

function collectWorkflowRunCommands(source) {
  const lines = source.split(/\r?\n/);
  const commands = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?<indent>\s*)(?:-\s+)?run:\s*(?<value>.*)$/.exec(lines[index]);
    if (!match?.groups) {
      continue;
    }

    const indent = match.groups.indent.length;
    const value = match.groups.value.trim();
    if (!['|', '|-', '>', '>-'].includes(value)) {
      commands.push(value);
      continue;
    }

    const block = [];
    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1];
      const nextIndent = /^\s*/.exec(nextLine)?.[0].length ?? 0;
      if (nextLine.length > 0 && nextIndent <= indent) {
        break;
      }
      index += 1;
      if (!/^\s*#/.test(nextLine)) {
        block.push(nextLine);
      }
    }
    commands.push(block.join('\n'));
  }

  return commands;
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
  const entrypoints = new Set(ROOT_GUARD_ENTRYPOINTS);
  for (const workflowSource of workflowSources) {
    for (const command of collectWorkflowRunCommands(workflowSource)) {
      for (const name of collectPackageScriptNames(command)) {
        if (packageScripts[name] !== undefined && GUARD_LEAF_SCRIPT_NAME.test(name)) {
          entrypoints.add(name);
        }
      }
    }
  }

  const reachablePackageScripts = collectReachablePackageScripts(packageScripts, entrypoints);
  const required = new Set();
  const guardBindings = new Map();

  for (const [name, command] of Object.entries(packageScripts)) {
    const directGuards = collectDirectGuardScripts(command);
    if (reachablePackageScripts.has(name)) {
      for (const script of directGuards) {
        required.add(script);
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

  return { required, unreachable };
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function structurallyReferencesGuard(source, script) {
  const executableSource = source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const escapedScript = escapeRegExp(script);
  const relativePath = String.raw`(?:\.\./)+${escapedScript}`;
  const pathJoinReference = executableSource
    .split(/\r?\n/)
    .some(
      (line) =>
        /\bpath\.join\(/.test(line) &&
        (line.includes(`'${script}'`) || line.includes(`"${script}"`))
    );

  return (
    pathJoinReference ||
    [
      new RegExp(String.raw`\b(?:from|import)\s*(?:\([^)]*?\)|['"]${relativePath}['"])`),
      new RegExp(String.raw`\bnew\s+URL\(\s*['"]${relativePath}['"]`),
      new RegExp(String.raw`['"]scripts\/${escapedScript}['"]`),
      new RegExp(String.raw`['"]scripts['"]\s*,\s*['"]${escapedScript}['"]`),
    ].some((pattern) => pattern.test(executableSource))
  );
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
        `${INVENTORY_LABEL}:${index + 1} must match "<guard>.<cjs|mjs> → wired/paired/armed → <purpose>"`
      );
    }

    const { purpose, script, states: stateSource } = match.groups;
    const states = stateSource.split('/');
    if (
      states.length !== REQUIRED_STATES.length ||
      states.some((state, stateIndex) => state !== REQUIRED_STATES[stateIndex])
    ) {
      throw new Error(
        `${INVENTORY_LABEL}:${index + 1} must declare states exactly as wired/paired/armed`
      );
    }
    if (scripts.has(script)) {
      throw new Error(`${INVENTORY_LABEL}:${index + 1} contains duplicate guard ${script}`);
    }

    scripts.add(script);
    entries.push({ purpose, script, states });
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

  const { required, unreachable } = collectRequiredGuardScripts(packageScripts, workflowSources);
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

  for (const entry of entries) {
    try {
      await access(path.join(scriptsRoot, entry.script));
    } catch {
      issues.push(`${entry.script}: classified guard script does not exist`);
    }

    if (entry.states.includes('paired') && !hasPairedTest(entry, testSources)) {
      issues.push(`${entry.script}: paired guard has no discoverable test under scripts/__tests__`);
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
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error('Warden guard inventory verification failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
