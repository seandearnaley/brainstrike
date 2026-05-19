#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

import {
  listWorkspacePackages,
  loadArchitectureDomainContract,
  validateArchitectureDomainContract,
} from './architecture-domain-contract.mjs';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set([
  '.next',
  '.turbo',
  'blob-report',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
]);

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

const walkSourceFiles = async ({ root, relativeDirectory }) => {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!(await pathExists(absoluteDirectory))) {
    return [];
  }

  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      for (const filePath of await walkSourceFiles({ root, relativeDirectory: relativePath })) {
        files.push(filePath);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }

  return files.sort();
};

const getScriptKind = (filePath) => {
  const extension = path.extname(filePath);
  if (extension === '.tsx') {
    return ts.ScriptKind.TSX;
  }
  if (extension === '.jsx') {
    return ts.ScriptKind.JSX;
  }
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
};

const getStringLiteralText = (node) => {
  if (!node) {
    return null;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
};

const collectImportSpecifiers = ({ sourceFile }) => {
  const imports = [];

  const addImport = ({ specifier, node }) => {
    if (typeof specifier !== 'string' || !specifier.startsWith('@brainstrike/')) {
      return;
    }

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    imports.push({
      specifier,
      line: line + 1,
      column: character + 1,
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addImport({
        specifier: getStringLiteralText(node.moduleSpecifier),
        node,
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isImportTypeNode(node)) {
      addImport({
        specifier: getStringLiteralText(node.argument?.literal),
        node,
      });
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isImportEqualsDeclaration(node)) {
      const moduleReference = node.moduleReference;
      if (ts.isExternalModuleReference(moduleReference)) {
        addImport({
          specifier: getStringLiteralText(moduleReference.expression),
          node,
        });
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      const importSpecifier = getStringLiteralText(firstArgument);
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) &&
        node.expression.escapedText === 'require' &&
        node.arguments.length > 0;
      if (isDynamicImport || isRequire) {
        addImport({ specifier: importSpecifier, node });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
};

const resolveWorkspacePackageSpecifier = ({ specifier, workspacePackageNames }) => {
  if (!specifier.startsWith('@brainstrike/')) {
    return null;
  }

  const [scope, packageName] = specifier.split('/');
  if (!scope || !packageName) {
    return null;
  }

  const workspacePackageName = `${scope}/${packageName}`;
  return workspacePackageNames.has(workspacePackageName) ? workspacePackageName : null;
};

const buildDomainLookups = ({ contract }) => {
  const packageToDomain = new Map();
  const allowedDomainDependencies = new Map();
  const approvedBoundaryExceptions = new Set();

  for (const domain of contract.domains) {
    const mayDependOn = new Set(domain.mayDependOn);
    mayDependOn.add(domain.id);
    allowedDomainDependencies.set(domain.id, mayDependOn);

    for (const packageName of domain.packages) {
      packageToDomain.set(packageName, domain.id);
    }
  }

  for (const exception of contract.boundaryExceptions ?? []) {
    approvedBoundaryExceptions.add(`${exception.sourcePackage}\0${exception.importedPackage}`);
  }

  return {
    packageToDomain,
    allowedDomainDependencies,
    approvedBoundaryExceptions,
  };
};

const findSourceWorkspacePackage = ({ filePath, workspacePackages }) => {
  for (const workspacePackage of workspacePackages) {
    const packageDirectory = `${workspacePackage.directory}${path.sep}`;
    if (filePath.startsWith(packageDirectory)) {
      return workspacePackage;
    }
  }
  return null;
};

export const validateArchitectureDomainBoundaries = async ({ root = process.cwd() } = {}) => {
  const contract = await loadArchitectureDomainContract({ root });
  const contractResult = await validateArchitectureDomainContract({ root, contract });
  if (contractResult.errors.length > 0) {
    throw new Error(
      `Architecture domain contract must pass before boundary validation:\n${contractResult.errors.join(
        '\n'
      )}`
    );
  }

  const workspacePackages = await listWorkspacePackages({ root });
  const workspacePackageNames = new Set(workspacePackages.map((workspacePackage) => workspacePackage.name));
  const { packageToDomain, allowedDomainDependencies, approvedBoundaryExceptions } = buildDomainLookups({
    contract,
  });
  const violations = [];
  const usedBoundaryExceptions = new Set();
  let checkedFileCount = 0;
  let checkedImportCount = 0;

  for (const workspacePackage of workspacePackages) {
    const sourceFiles = await walkSourceFiles({ root, relativeDirectory: workspacePackage.directory });
    for (const filePath of sourceFiles) {
      const sourceWorkspacePackage = findSourceWorkspacePackage({ filePath, workspacePackages });
      if (!sourceWorkspacePackage) {
        continue;
      }

      const sourcePackageDomain = packageToDomain.get(sourceWorkspacePackage.name);
      if (!sourcePackageDomain) {
        continue;
      }

      checkedFileCount += 1;
      const sourceText = await readFile(path.join(root, filePath), 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(filePath)
      );
      const imports = collectImportSpecifiers({ sourceFile });

      for (const importedSpecifier of imports) {
        const importedPackage = resolveWorkspacePackageSpecifier({
          specifier: importedSpecifier.specifier,
          workspacePackageNames,
        });
        if (!importedPackage) {
          continue;
        }

        checkedImportCount += 1;
        const importedDomain = packageToDomain.get(importedPackage);
        const importedDomainLabel = importedDomain ?? 'unassigned-domain';
        const allowedDomains = allowedDomainDependencies.get(sourcePackageDomain);
        if (allowedDomains?.has(importedDomain)) {
          continue;
        }

        const exceptionKey = `${sourceWorkspacePackage.name}\0${importedPackage}`;
        if (approvedBoundaryExceptions.has(exceptionKey)) {
          usedBoundaryExceptions.add(exceptionKey);
          continue;
        }

        violations.push({
          filePath,
          line: importedSpecifier.line,
          column: importedSpecifier.column,
          sourcePackage: sourceWorkspacePackage.name,
          sourceDomain: sourcePackageDomain,
          importedPackage,
          importedDomain,
          specifier: importedSpecifier.specifier,
          message: `${sourceWorkspacePackage.name} (${sourcePackageDomain}) must not import ${importedPackage} (${importedDomainLabel})`,
        });
      }
    }
  }

  violations.sort((left, right) => {
    const pathComparison = left.filePath.localeCompare(right.filePath);
    if (pathComparison !== 0) {
      return pathComparison;
    }

    const lineComparison = left.line - right.line;
    if (lineComparison !== 0) {
      return lineComparison;
    }

    return left.column - right.column;
  });

  const staleBoundaryExceptions = [...approvedBoundaryExceptions]
    .filter((exceptionKey) => !usedBoundaryExceptions.has(exceptionKey))
    .map((exceptionKey) => {
      const [sourcePackage, importedPackage] = exceptionKey.split('\0');
      return {
        sourcePackage,
        importedPackage,
        message: `approved boundary exception is stale: ${sourcePackage} -> ${importedPackage}`,
      };
    })
    .sort((left, right) => {
      const sourceComparison = left.sourcePackage.localeCompare(right.sourcePackage);
      if (sourceComparison !== 0) {
        return sourceComparison;
      }
      return left.importedPackage.localeCompare(right.importedPackage);
    });

  return {
    staleBoundaryExceptions,
    violations,
    summary: {
      checkedFileCount,
      checkedImportCount,
      approvedBoundaryExceptionCount: approvedBoundaryExceptions.size,
      usedBoundaryExceptionCount: usedBoundaryExceptions.size,
      workspaceCount: workspacePackages.length,
    },
  };
};

const runCli = async () => {
  const result = await validateArchitectureDomainBoundaries({ root: process.cwd() });

  if (result.violations.length > 0) {
    console.error('Architecture domain boundaries failed:');
    for (const violation of result.violations) {
      console.error(
        `- ${violation.filePath}:${violation.line}:${violation.column} ${violation.message} via ${violation.specifier}`
      );
    }
    process.exitCode = 1;
    return;
  }

  if (result.staleBoundaryExceptions.length > 0) {
    console.error('Architecture domain boundary exceptions are stale:');
    for (const exception of result.staleBoundaryExceptions) {
      console.error(`- ${exception.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Architecture domain boundaries passed: ${result.summary.checkedImportCount} imports across ${result.summary.checkedFileCount} files; ${result.summary.usedBoundaryExceptionCount}/${result.summary.approvedBoundaryExceptionCount} approved boundary exceptions used.`
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
