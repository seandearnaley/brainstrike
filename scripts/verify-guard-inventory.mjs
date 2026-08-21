import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVENTORY_ROW =
  /^(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs)) → (?<states>[a-z]+(?:\/[a-z]+)*) → (?<purpose>\S.*)$/;
const REQUIRED_STATES = ['wired', 'paired', 'armed'];
const REQUIRED_PATH_SCRIPT_NAME =
  /^(?:arch:|boundaries$|coverage:enforce$|lint(?::|$)|secrets:scan$)/;
const DIRECT_NODE_GUARD = /\bnode scripts\/(?<script>[a-z0-9][a-z0-9.-]*\.(?:cjs|mjs))\b/g;
const INVENTORY_LABEL = 'scripts/_guard-inventory.md';
const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function collectRequiredGuardScripts(packageScripts) {
  const required = new Set();

  for (const [name, command] of Object.entries(packageScripts)) {
    if (!REQUIRED_PATH_SCRIPT_NAME.test(name)) {
      continue;
    }

    for (const match of command.matchAll(DIRECT_NODE_GUARD)) {
      if (match.groups?.script) {
        required.add(match.groups.script);
      }
    }
  }

  return required;
}

export async function loadGuardTestSources(scriptsRoot) {
  const testsRoot = path.join(scriptsRoot, '__tests__');
  const relativePaths = (await readdir(testsRoot, { recursive: true })).filter((relativePath) =>
    relativePath.endsWith('.test.mjs')
  );

  return Promise.all(
    relativePaths.map(async (relativePath) => ({
      path: relativePath,
      source: await readFile(path.join(testsRoot, relativePath), 'utf8'),
    }))
  );
}

function hasPairedTest(script, testSources) {
  const basename = script.replace(/\.(?:cjs|mjs)$/, '');
  return testSources.some(
    (testSource) =>
      path.basename(testSource.path) === `${basename}.test.mjs` ||
      testSource.source.includes(script)
  );
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
}) {
  const entries = parseGuardInventory(inventorySource);
  const issues = [];
  const inventoryScripts = new Set(entries.map((entry) => entry.script));

  for (const requiredScript of [...collectRequiredGuardScripts(packageScripts)].sort()) {
    if (!inventoryScripts.has(requiredScript)) {
      issues.push(
        `${requiredScript}: required root guard script is missing from ${INVENTORY_LABEL}`
      );
    }
  }

  for (const entry of entries) {
    try {
      await access(path.join(scriptsRoot, entry.script));
    } catch {
      issues.push(`${entry.script}: classified guard script does not exist`);
    }

    if (entry.states.includes('paired') && !hasPairedTest(entry.script, testSources)) {
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
