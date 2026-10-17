import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { classifyCommand, extractProject, flattenScript } from './ts7-parity-check.mjs';
import { inspectTsconfigProgram } from './verify-test-tsconfig-program.mjs';
import { workspacePackages } from './workspace-packages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?tsx?)$/u;
const TYPESCRIPT = /\.[cm]?tsx?$/u;
const GENERATED = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test-results',
  'playwright-report',
]);

export function discoverTypeScriptTests(directory, relative = '') {
  return readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(relative, entry.name);
    if (GENERATED.has(entry.name)) {
      return [];
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Test discovery requires an explicit symlink owner: ${directory}/${file}`);
    }
    if (entry.isDirectory()) {
      return discoverTypeScriptTests(directory, file);
    }
    return entry.isFile() && TYPESCRIPT.test(file) && TEST.test(file) ? [file] : [];
  });
}

function referencedProjects(project, selected = new Set()) {
  if (selected.has(project)) {
    return selected;
  }
  selected.add(project);
  const config = ts.readConfigFile(project, ts.sys.readFile);
  if (config.error) {
    throw new Error(`Cannot read referenced compiler project ${project}`);
  }
  for (const reference of config.config.references ?? []) {
    const target = path.resolve(path.dirname(project), reference.path);
    referencedProjects(
      target.endsWith('.json') ? target : path.join(target, 'tsconfig.json'),
      selected
    );
  }
  return selected;
}

export function canonicalTestPrograms(pkg) {
  const compiler = new Set();
  const effect = new Set();
  if (!pkg.scripts['type-check']) {
    return { compiler, effect };
  }
  for (const command of flattenScript(pkg, 'type-check')) {
    const classified = classifyCommand(command);
    if (classified.kind === 'noEmit') {
      if (
        command.startsWith('tsc') &&
        !/^tsc --noEmit(?: (?:--project|-p)(?:=| )\S+)?$/u.test(command)
      ) {
        throw new Error(`Unsupported compiler inspection options: ${command}`);
      }
      compiler.add(path.resolve(pkg.dir, classified.project ?? 'tsconfig.json'));
    } else if (classified.kind === 'build') {
      const project = path.resolve(pkg.dir, extractProject(command) ?? 'tsconfig.json');
      for (const referenced of referencedProjects(project)) {
        compiler.add(referenced);
      }
    } else if (command.startsWith('effect-tsgo ')) {
      const match = command.match(/^effect-tsgo diagnostics --project (\S+) --strict$/u);
      if (!match) {
        throw new Error(`Unsupported Effect inspection command: ${command}`);
      }
      effect.add(path.resolve(pkg.dir, match[1]));
    } else if (!/^node --check \S+$/u.test(command)) {
      throw new Error(`Unsupported type-check command in ${pkg.name}: ${command}`);
    }
  }
  if (pkg.manifest?.dependencies?.effect && effect.size === 0) {
    throw new Error(`${pkg.name} consumes Effect but has no canonical diagnostics command`);
  }
  return { compiler, effect };
}

/** List-only compiler inspection is shared across both axes and duplicate projects. */
export function inventoryTestPrograms(repoRoot, inspect = inspectTsconfigProgram) {
  const packages = workspacePackages(repoRoot);
  const cache = new Map();
  const selectedFiles = (projects) => {
    const files = new Set();
    for (const project of projects) {
      if (!cache.has(project)) {
        const selected = inspect(project);
        if (selected.length === 0) {
          throw new Error(`Compiler inspection selected an empty program: ${project}`);
        }
        cache.set(project, selected);
      }
      for (const file of cache.get(project)) {
        files.add(path.resolve(path.dirname(project), file));
      }
    }
    return files;
  };
  const missing = [];
  const discovered = new Set();
  const reports = [];
  for (const pkg of packages) {
    const programs = canonicalTestPrograms(pkg);
    const compiler = selectedFiles(programs.compiler);
    const effect = selectedFiles(programs.effect);
    const files = discoverTypeScriptTests(pkg.dir);
    for (const file of files) {
      const absolute = path.join(pkg.dir, file);
      const relative = path.relative(repoRoot, absolute).replaceAll('\\', '/');
      discovered.add(relative);
      for (const [axis, selected] of [
        ['typescript', compiler],
        ['effect', effect],
      ]) {
        if ((axis === 'typescript' || programs.effect.size > 0) && !selected.has(absolute)) {
          missing.push({ axis, path: relative });
        }
      }
    }
    reports.push({
      compiler: programs.compiler.size,
      effect: programs.effect.size,
      package: pkg.name,
      tests: files.length,
    });
  }
  return { discovered, missing, projectsInspected: cache.size, reports };
}

export function evaluateTestProgramDebt(inventory, policy) {
  const errors = [];
  const assets = new Map();
  for (const asset of policy.executionAssets) {
    if (
      assets.has(asset.path) ||
      !asset.owner ||
      !asset.reason ||
      !inventory.discovered.has(asset.path)
    ) {
      errors.push(`Invalid or stale execution asset: ${asset.path}`);
    }
    assets.set(asset.path, asset);
  }
  const actual = new Set(
    inventory.missing
      .filter((entry) => !assets.has(entry.path))
      .map((entry) => `${entry.axis}:${entry.path}`)
  );
  const allowed = new Set();
  for (const group of policy.debt) {
    if (
      !(
        ['typescript', 'effect'].includes(group.axis) &&
        group.owner &&
        group.reason &&
        Array.isArray(group.paths)
      ) ||
      group.paths.length === 0
    ) {
      errors.push(`Invalid debt group: ${group.axis}`);
      continue;
    }
    for (const file of group.paths) {
      const key = `${group.axis}:${file}`;
      if (allowed.has(key)) {
        errors.push(`Duplicate debt entry: ${key}`);
      }
      allowed.add(key);
      if (!actual.has(key)) {
        errors.push(`Stale debt entry (remove it): ${key}`);
      }
    }
  }
  for (const key of actual) {
    if (!allowed.has(key)) {
      errors.push(`Unchecked test: ${key}`);
    }
  }
  for (const file of assets.keys()) {
    if (!inventory.missing.some((entry) => entry.path === file && entry.axis === 'typescript')) {
      errors.push(`Execution asset is now compiler-covered (remove classification): ${file}`);
    }
  }
  return errors.sort();
}

export function auditWorkspaceTestPrograms(repoRoot = root) {
  const policy = JSON.parse(
    readFileSync(path.join(repoRoot, 'scripts/test-program-debt.json'), 'utf8')
  );
  if (
    policy.version !== 1 ||
    !Array.isArray(policy.debt) ||
    !Array.isArray(policy.executionAssets)
  ) {
    throw new Error('Invalid test-program-debt policy');
  }
  const inventory = inventoryTestPrograms(repoRoot);
  return { ...inventory, errors: evaluateTestProgramDebt(inventory, policy) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = auditWorkspaceTestPrograms();
  console.log(
    JSON.stringify(
      {
        errors: inventory.errors,
        projectsInspected: inventory.projectsInspected,
        reports: inventory.reports,
      },
      null,
      2
    )
  );
  process.exitCode = inventory.errors.length === 0 ? 0 : 1;
}
