import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const typesSourceDirectory = path.join(repoRoot, 'packages/types/src');
const negativeControlSourceDirectory = path.join(
  import.meta.dirname,
  'fixtures/desktop-ipc-type-boundary/root/src'
);
const electronApiNamePattern = /Electron[A-Za-z0-9]*API$/i;

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(entryPath);
      }
      return entry.isFile() && /\.(?:d\.)?ts$/.test(entry.name) ? [entryPath] : [];
    })
  );
  return nestedFiles.flat();
}

function declarationName(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

function inspectSource(sourceFile, checker) {
  const filePath = sourceFile.fileName;
  const findings = [];

  const relativePathParts = path.relative(typesSourceDirectory, filePath).split(path.sep);
  if (
    relativePathParts.some((pathPart) => pathPart.replace(/\.(?:d\.)?ts$/, '') === 'electron-api')
  ) {
    findings.push('forbidden electron-api module');
  }

  const sourceSymbol = checker.getSymbolAtLocation(sourceFile);
  const exportedSymbols = new Set(
    (sourceSymbol ? checker.getExportsOfModule(sourceSymbol) : []).map((symbol) =>
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    )
  );

  function isExportedDeclaration(node) {
    const variableStatement =
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent)
        ? node.parent.parent
        : null;
    const hasExportModifier =
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) ||
      (variableStatement !== null &&
        ts
          .getModifiers(variableStatement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
    if (hasExportModifier) {
      return true;
    }
    const name = node.name;
    if (!(name && ts.isIdentifier(name))) {
      return false;
    }
    const symbol = checker.getSymbolAtLocation(name);
    return Boolean(symbol && exportedSymbols.has(symbol));
  }

  function carriesElectronApiCapability(node) {
    return Boolean(checker.getPropertyOfType(checker.getTypeAtLocation(node), 'electronAPI'));
  }

  function reportExportedElectronApiObject(node, name) {
    if (isExportedDeclaration(node) && carriesElectronApiCapability(node)) {
      findings.push(`forbidden exported electronAPI object declaration: ${name}`);
    }
  }

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|\/)electron-api(?:\.[cm]?[jt]s)?$/.test(node.moduleSpecifier.text)
    ) {
      findings.push(`forbidden electron-api module reference: ${node.moduleSpecifier.text}`);
    }

    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      const name = declarationName(node);
      if (name && electronApiNamePattern.test(name)) {
        findings.push(`forbidden Electron bridge declaration: ${name}`);
      }
      if (name) {
        reportExportedElectronApiObject(node, name);
      }
      if (
        name === 'Window' &&
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        carriesElectronApiCapability(node)
      ) {
        findings.push('forbidden Window electronAPI capability');
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      reportExportedElectronApiObject(node, node.name.text);
    }

    if (ts.isExportAssignment(node) && carriesElectronApiCapability(node.expression)) {
      findings.push('forbidden exported electronAPI object declaration: default');
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function inspectProgram(rootNames) {
  const program = ts.createProgram({
    options: {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.Latest,
      types: [],
    },
    rootNames,
  });
  const checker = program.getTypeChecker();
  return rootNames.map((filePath) => {
    const sourceFile = program.getSourceFile(filePath);
    assert.ok(sourceFile, `TypeScript did not load ${filePath}`);
    return { filePath, findings: inspectSource(sourceFile, checker) };
  });
}

describe('@brainstrike/types desktop IPC type boundary', () => {
  it('recursively excludes Electron bridge modules, APIs, and global Window capabilities', async () => {
    const sourceFiles = await listTypeScriptFiles(typesSourceDirectory);
    const inspections = inspectProgram(sourceFiles);
    const violations = inspections.flatMap(({ filePath, findings }) =>
      findings.map((finding) => `${path.relative(repoRoot, filePath)}: ${finding}`)
    );

    assert.deepEqual(violations, []);
  });

  it('negative control catches recursively nested aliases, heritage, and Electron API declarations', async () => {
    const sourceFiles = await listTypeScriptFiles(negativeControlSourceDirectory);
    assert.ok(
      sourceFiles.some(
        (filePath) =>
          path.relative(negativeControlSourceDirectory, filePath) ===
          path.join('platform', 'nested', 'forbidden-desktop-api.ts')
      ),
      'recursive discovery did not reach the nested negative-control source'
    );
    const findings = inspectProgram(sourceFiles).flatMap((inspection) => inspection.findings);

    assert.ok(
      findings.includes('forbidden electron-api module'),
      `missing electron-api module finding: ${findings.join(', ')}`
    );
    assert.ok(
      findings.includes('forbidden electron-api module reference: ./electron-api.js'),
      `missing electron-api module-reference finding: ${findings.join(', ')}`
    );
    assert.ok(
      findings.includes('forbidden Electron bridge declaration: DesktopElectronAPI'),
      `missing DesktopElectronAPI finding: ${findings.join(', ')}`
    );
    assert.ok(
      findings.includes('forbidden Electron bridge declaration: DesktopElectronApi'),
      `missing DesktopElectronApi finding: ${findings.join(', ')}`
    );
    assert.ok(
      findings.includes(
        'forbidden exported electronAPI object declaration: ExportedDesktopPlatformAlias'
      ),
      `missing exported alias finding: ${findings.join(', ')}`
    );
    assert.ok(
      findings.includes(
        'forbidden exported electronAPI object declaration: exportedDesktopPlatformObject'
      ),
      `missing exported object finding: ${findings.join(', ')}`
    );
    assert.ok(
      findings.includes('forbidden Window electronAPI capability'),
      `missing inherited Window capability finding: ${findings.join(', ')}`
    );
  });
});
