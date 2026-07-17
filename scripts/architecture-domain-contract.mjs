#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_CONTRACT_PATH = 'architecture/domain-map.json';

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const pathExists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

export const listWorkspacePackageJsons = async ({ root }) => {
  const workspaceRoots = ['apps', 'packages'];
  const packageJsons = [];

  for (const workspaceRoot of workspaceRoots) {
    const absoluteWorkspaceRoot = path.join(root, workspaceRoot);
    if (!(await pathExists(absoluteWorkspaceRoot))) {
      continue;
    }

    const entries = await readdir(absoluteWorkspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        packageJsons.push(path.join(workspaceRoot, entry.name, 'package.json'));
      }
    }
  }

  return packageJsons.sort();
};

export const listWorkspacePackages = async ({ root }) => {
  const packageJsons = await listWorkspacePackageJsons({ root });
  const packages = [];

  for (const packageJson of packageJsons) {
    const absolutePackageJson = path.join(root, packageJson);
    if (!(await pathExists(absolutePackageJson))) {
      continue;
    }
    const packageManifest = await readJson(absolutePackageJson);
    if (typeof packageManifest.name !== 'string' || packageManifest.name.length === 0) {
      throw new Error(`${packageJson} is missing a package name`);
    }
    packages.push({
      directory: path.dirname(packageJson),
      name: packageManifest.name,
      packageJson,
    });
  }

  return packages;
};

export const loadArchitectureDomainContract = async ({
  root = process.cwd(),
  contractPath = DEFAULT_CONTRACT_PATH,
} = {}) => readJson(path.join(root, contractPath));

const assertArray = ({ value, label, errors }) => {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return [];
  }
  return value;
};

export const validateArchitectureDomainContract = async ({
  root = process.cwd(),
  contract,
} = {}) => {
  const errors = [];
  const workspacePackages = await listWorkspacePackages({ root });
  const workspacePackageNames = new Set(
    workspacePackages.map((workspacePackage) => workspacePackage.name)
  );

  if (!contract || typeof contract !== 'object') {
    return {
      errors: ['architecture/domain-map.json must contain a JSON object'],
      summary: {
        domainCount: 0,
        stackPhaseCount: 0,
        workspaceCount: workspacePackages.length,
      },
    };
  }

  if (contract.version !== 1) {
    errors.push('architecture/domain-map.json version must be 1');
  }

  const domains = assertArray({ errors, label: 'domains', value: contract.domains });
  const stack = assertArray({ errors, label: 'stack', value: contract.stack });
  const domainIds = new Set();
  const classifiedPackages = new Map();

  for (const domain of domains) {
    if (!domain || typeof domain !== 'object') {
      errors.push('Every domain must be an object');
      continue;
    }

    if (typeof domain.id !== 'string' || domain.id.length === 0) {
      errors.push('Every domain must have a non-empty id');
      continue;
    }

    if (domainIds.has(domain.id)) {
      errors.push(`Domain ${domain.id} is declared more than once`);
    }
    domainIds.add(domain.id);

    const packages = assertArray({
      errors,
      label: `Domain ${domain.id} packages`,
      value: domain.packages,
    });

    for (const packageName of packages) {
      if (!workspacePackageNames.has(packageName)) {
        errors.push(`Domain ${domain.id} references unknown workspace package ${packageName}`);
        continue;
      }

      const domainsForPackage = classifiedPackages.get(packageName) ?? [];
      domainsForPackage.push(domain.id);
      classifiedPackages.set(packageName, domainsForPackage);
    }
  }

  for (const domain of domains) {
    if (!domain || typeof domain !== 'object' || typeof domain.id !== 'string') {
      continue;
    }
    const mayDependOn = assertArray({
      errors,
      label: `Domain ${domain.id} mayDependOn`,
      value: domain.mayDependOn,
    });
    for (const dependencyDomainId of mayDependOn) {
      if (!domainIds.has(dependencyDomainId)) {
        errors.push(`Domain ${domain.id} mayDependOn unknown domain ${dependencyDomainId}`);
      }
    }
  }

  for (const workspacePackage of workspacePackages) {
    const classifications = classifiedPackages.get(workspacePackage.name) ?? [];
    if (classifications.length === 0) {
      errors.push(
        `Workspace package ${workspacePackage.name} is not classified in architecture/domain-map.json`
      );
    }
    if (classifications.length > 1) {
      errors.push(`Workspace package ${workspacePackage.name} is classified more than once`);
    }
  }

  let previousPhaseId = null;
  const stackIds = new Set();
  for (const phase of stack) {
    if (!phase || typeof phase !== 'object') {
      errors.push('Every stack phase must be an object');
      continue;
    }

    if (typeof phase.id !== 'string' || phase.id.length === 0) {
      errors.push('Every stack phase must have a non-empty id');
      continue;
    }

    if (stackIds.has(phase.id)) {
      errors.push(`Stack phase ${phase.id} is declared more than once`);
    }
    stackIds.add(phase.id);

    const actualDependsOn = phase.dependsOn ?? null;
    if (actualDependsOn !== previousPhaseId) {
      errors.push(
        `Stack phase ${phase.id} dependsOn ${actualDependsOn}, but the previous phase is ${previousPhaseId}`
      );
    }

    if (typeof phase.planningArtifact !== 'string' || !phase.planningArtifact.endsWith('.html')) {
      errors.push(`Stack phase ${phase.id} must reference an HTML planningArtifact`);
    } else if (!(await pathExists(path.join(root, phase.planningArtifact)))) {
      errors.push(
        `Stack phase ${phase.id} planningArtifact ${phase.planningArtifact} does not exist`
      );
    }

    previousPhaseId = phase.id;
  }

  const boundaryExceptions = contract.boundaryExceptions ?? [];
  if (Array.isArray(boundaryExceptions)) {
    const exceptionIds = new Set();
    for (const exception of boundaryExceptions) {
      if (!exception || typeof exception !== 'object') {
        errors.push('Every boundary exception must be an object');
        continue;
      }

      if (typeof exception.id !== 'string' || exception.id.length === 0) {
        errors.push('Every boundary exception must have a non-empty id');
      } else if (exceptionIds.has(exception.id)) {
        errors.push(`Boundary exception ${exception.id} is declared more than once`);
      } else {
        exceptionIds.add(exception.id);
      }

      if (!workspacePackageNames.has(exception.sourcePackage)) {
        errors.push(
          `Boundary exception ${exception.id ?? '<missing-id>'} references unknown sourcePackage ${exception.sourcePackage}`
        );
      }
      if (!workspacePackageNames.has(exception.importedPackage)) {
        errors.push(
          `Boundary exception ${exception.id ?? '<missing-id>'} references unknown importedPackage ${exception.importedPackage}`
        );
      }
      if (typeof exception.reason !== 'string' || exception.reason.trim().length === 0) {
        errors.push(`Boundary exception ${exception.id ?? '<missing-id>'} must have a reason`);
      }
      if (!stackIds.has(exception.retireByPhase)) {
        errors.push(
          `Boundary exception ${exception.id ?? '<missing-id>'} retireByPhase must reference a stack phase`
        );
      }
    }
  } else {
    errors.push('boundaryExceptions must be an array when present');
  }

  return {
    errors: errors.sort(),
    summary: {
      classifiedPackageCount: classifiedPackages.size,
      domainCount: domains.length,
      stackPhaseCount: stack.length,
      workspaceCount: workspacePackages.length,
    },
  };
};

const runCli = async () => {
  const root = process.cwd();
  const contract = await loadArchitectureDomainContract({ root });
  const result = await validateArchitectureDomainContract({ contract, root });

  if (result.errors.length > 0) {
    console.error('Architecture domain contract failed:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Architecture domain contract passed: ${result.summary.classifiedPackageCount} packages across ${result.summary.domainCount} domains and ${result.summary.stackPhaseCount} stack phases.`
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
