import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVENTORY_ROW =
  /^(?<script>[a-z0-9][a-z0-9.-]*\.mjs) → (?<states>[a-z]+(?:\/[a-z]+)*) → (?<purpose>\S.*)$/;
const REQUIRED_STATES = ['wired', 'paired', 'armed'];

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
        `line ${index + 1} must match "<guard>.mjs → wired/paired/armed → <purpose>"`
      );
    }

    const { purpose, script, states: stateSource } = match.groups;
    const states = stateSource.split('/');
    if (
      states.length !== REQUIRED_STATES.length ||
      states.some((state, stateIndex) => state !== REQUIRED_STATES[stateIndex])
    ) {
      throw new Error(`line ${index + 1} must declare states exactly as wired/paired/armed`);
    }
    if (scripts.has(script)) {
      throw new Error(`line ${index + 1} contains duplicate guard ${script}`);
    }

    scripts.add(script);
    entries.push({ purpose, script, states });
  }

  if (entries.length === 0) {
    throw new Error('guard inventory must classify at least one guard');
  }

  return entries;
}

export async function validateGuardInventory({ inventorySource, scriptsRoot }) {
  const entries = parseGuardInventory(inventorySource);
  const issues = [];

  for (const entry of entries) {
    try {
      await access(path.join(scriptsRoot, entry.script));
    } catch {
      issues.push(`${entry.script}: classified guard script does not exist`);
    }
  }

  return issues;
}

export async function main(options = {}) {
  const scriptsRoot = path.resolve(
    options.scriptsRoot ??
      (options.repoRoot ? path.join(options.repoRoot, 'scripts') : undefined) ??
      process.argv[2] ??
      path.dirname(fileURLToPath(import.meta.url))
  );
  const inventorySource = await readFile(path.join(scriptsRoot, '_guard-inventory.md'), 'utf8');
  const issues = await validateGuardInventory({ inventorySource, scriptsRoot });

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
