import { realpathSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const INVENTORY_ROW =
  /^(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs)) → (?<states>[a-z]+(?:\/[a-z]+)*) → (?<purpose>\S.*)$/;
const REQUIRED_STATES = ['wired', 'paired', 'armed'];
const CONTRACT_TEST = /\bcontract: scripts\/__tests__\/(?<path>[a-z0-9][a-z0-9.-]*\.test\.mjs)\b/;
const INVENTORY_LABEL = 'scripts/_guard-inventory.md';
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUIRED_WORKFLOW_PATH = '.github/workflows/test.yml';
const REQUIRED_STATIC_CONDITION =
  "always() && (needs.admission.result != 'success' || needs.admission.outputs.admitted == 'true')";
const CANONICAL_PACKAGE_RUNNER = 'node scripts/run-script-contracts.mjs';
const CANONICAL_WORKFLOW_COMMAND = 'pnpm test:scripts';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateRequiredRunner({ packageScripts, workflowSource }) {
  const workflow = parseYaml(workflowSource);
  const staticJob = workflow?.jobs?.static;
  const issues = [];

  if (packageScripts['test:scripts'] !== CANONICAL_PACKAGE_RUNNER) {
    issues.push('test:scripts must execute the canonical scripts/run-script-contracts.mjs runner');
  }

  if (!isRecord(staticJob) || staticJob.if !== REQUIRED_STATIC_CONDITION) {
    issues.push('required Static job must retain the admission-gated execution condition');
  }

  const runnerSteps = Array.isArray(staticJob?.steps)
    ? staticJob.steps.filter((step) => isRecord(step) && step.run === CANONICAL_WORKFLOW_COMMAND)
    : [];
  if (runnerSteps.length !== 1) {
    issues.push(
      'required Static job must invoke exactly one unconditional "pnpm test:scripts" step'
    );
  } else if (
    runnerSteps[0].if !== undefined ||
    (runnerSteps[0]['continue-on-error'] !== undefined &&
      runnerSteps[0]['continue-on-error'] !== false) ||
    (staticJob['continue-on-error'] !== undefined && staticJob['continue-on-error'] !== false)
  ) {
    issues.push('required Static runner must be unconditional and blocking');
  }

  return issues;
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

export function contractPathForEntry(entry) {
  const declaredPath = CONTRACT_TEST.exec(entry.purpose)?.groups?.path;
  if (declaredPath) {
    return `scripts/__tests__/${declaredPath}`;
  }

  const basename = entry.script.replace(/\.(?:cjs|mjs)$/, '');
  return `scripts/__tests__/${basename}.test.mjs`;
}

export async function loadGuardTestPaths(scriptsRoot) {
  return (await readdir(path.join(scriptsRoot, '__tests__')))
    .filter((relativePath) => relativePath.endsWith('.test.mjs'))
    .map((relativePath) => `scripts/__tests__/${relativePath}`)
    .sort();
}

export async function validateGuardInventory({
  inventorySource,
  packageScripts,
  repoRoot,
  scriptsRoot,
  testPaths,
  workflowSource,
}) {
  const entries = parseGuardInventory(inventorySource);
  const issues = validateRequiredRunner({ packageScripts, workflowSource });
  const availableTests = new Set(testPaths);

  for (const entry of entries) {
    try {
      await access(path.join(scriptsRoot, entry.script));
    } catch {
      issues.push(`${entry.script}: classified guard script does not exist`);
    }

    const contractPath = contractPathForEntry(entry);
    if (!availableTests.has(contractPath)) {
      issues.push(`${entry.script}: paired contract ${contractPath} is not discoverable`);
    }
  }

  if (path.resolve(repoRoot) !== path.resolve(path.dirname(scriptsRoot))) {
    issues.push('scripts root must belong to the validated repository root');
  }

  return issues;
}

export async function loadRepositoryContract(repoRoot = DEFAULT_REPO_ROOT) {
  const scriptsRoot = path.join(repoRoot, 'scripts');
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const inventorySource = await readFile(path.join(scriptsRoot, '_guard-inventory.md'), 'utf8');
  const workflowSource = await readFile(path.join(repoRoot, REQUIRED_WORKFLOW_PATH), 'utf8');
  const entries = parseGuardInventory(inventorySource);
  const testPaths = await loadGuardTestPaths(scriptsRoot);
  const issues = await validateGuardInventory({
    inventorySource,
    packageScripts: packageJson.scripts,
    repoRoot,
    scriptsRoot,
    testPaths,
    workflowSource,
  });

  return {
    contractPaths: entries.map(contractPathForEntry),
    issues,
    testPaths,
  };
}

export async function main({ repoRoot = path.resolve(process.argv[2] ?? DEFAULT_REPO_ROOT) } = {}) {
  const { issues } = await loadRepositoryContract(repoRoot);

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
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error) => {
    console.error('Warden guard inventory verification failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
