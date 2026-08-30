#!/usr/bin/env node

// Guard: the desktop MAIN process inserts into `brainstrike_assistant_run_events`
// and `brainstrike_assistant_thread_runs` without ever creating them. Neither
// table is migration-backed (both carry ON DELETE CASCADE FKs to parents no
// migration creates), so what keeps those writes safe is runId PROVENANCE: the
// single producer of a `memory.runId` is `createThreadRunId`, whose only caller
// awaits `repository.createThreadRun` → the schema bootstrap. A SECOND producer
// that mints an id without that bootstrap makes a genuine 42P01 hazard real —
// and the run-event writer's failure on that path is only partly loud.
//
// See docs/agents/assistant-persistence.md
// § RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP.
//
// SCOPE — read before trusting a green run. This guard pins the identity and
// reach of the EXISTING producer:
//   - `createThreadRunId` is declared exactly once, in the owning module;
//   - it has exactly one call site, in that same module;
//   - it is NOT exported, so no other module can reuse it.
// It CANNOT detect a brand-new minter that generates an id some other way
// (`crypto.randomUUID()` in a background/cron run). That residual gap is why
// the doc section, not this script, is the authority. Widening the guard to
// "any id-shaped expression reaching a memory payload" was considered and
// rejected as unmaintainably fuzzy.

import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCER_NAME = 'createThreadRunId';
const OWNING_FILE = 'packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
];

const IGNORE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/.git',
  '**/.git/**',
  '**/dist',
  '**/dist/**',
  '**/.turbo',
  '**/.turbo/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/playwright-report',
  '**/playwright-report/**',
  '**/test-results',
  '**/test-results/**',
  '**/.vite',
  '**/.vite/**',
  '**/blob-report',
  '**/blob-report/**',
  '**/reports',
  '**/reports/**',
  // Tests may reference the producer freely; they cannot introduce a
  // production request path.
  '**/__tests__',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/e2e',
  '**/e2e/**',
];

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

function findProducerSyntax(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `${filePath}:${position.line + 1}:${position.character + 1}: could not be parsed, ` +
        `so runId provenance cannot be verified — ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          ' '
        )}`
    );
  }
  const calls = [];
  const declarations = [];
  const exports = [];

  function visit(node) {
    const isProducerFunction =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name?.text === PRODUCER_NAME;
    if (isProducerFunction) {
      declarations.push(node.name.getStart(sourceFile));
      if (
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exports.push(node.name.getStart(sourceFile));
      }
    }

    if (ts.isIdentifier(node) && node.text === PRODUCER_NAME) {
      const isDeclarationName =
        (ts.isFunctionDeclaration(node.parent) || ts.isFunctionExpression(node.parent)) &&
        node.parent.name === node;
      if (isDeclarationName) {
        return;
      }

      if (ts.isExportSpecifier(node.parent) || ts.isExportAssignment(node.parent)) {
        exports.push(node.getStart(sourceFile));
      } else {
        // Any executable reference can leak or invoke the supposedly private
        // producer: direct calls, property access, constructors, aliases, and
        // imports all count. Comments and literals have no Identifier node.
        calls.push(node.getStart(sourceFile));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { calls, declarations, exports };
}

/**
 * Scan non-test source for references to the run-id producer.
 * Returns `{ violations, declarationCount, callCount }`; violations carry
 * `{ filePath, lineNumber, reason }`.
 */
export async function findAssistantRunIdProducerViolations({ root = REPO_ROOT } = {}) {
  const sourceFiles = (
    await Array.fromAsync(
      glob(SOURCE_PATTERNS, {
        cwd: root,
        exclude: IGNORE_PATTERNS,
        withFileTypes: true,
      })
    )
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    );

  const violations = [];
  let declarationCount = 0;
  let callCount = 0;

  for (const filePath of sourceFiles.sort()) {
    const sourceText = await readFile(path.join(root, filePath), 'utf8');
    if (!sourceText.includes(PRODUCER_NAME)) {
      continue;
    }
    const producerSyntax = findProducerSyntax(filePath, sourceText);

    for (const matchIndex of producerSyntax.declarations) {
      declarationCount += 1;
      if (filePath !== OWNING_FILE) {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, matchIndex),
          reason: `${PRODUCER_NAME} must be declared only in ${OWNING_FILE}`,
        });
      }
    }

    for (const matchIndex of producerSyntax.exports) {
      violations.push({
        filePath,
        lineNumber: getLineNumber(sourceText, matchIndex),
        reason: `${PRODUCER_NAME} must stay module-private (exporting it lets another module mint a runId)`,
      });
    }

    for (const matchIndex of producerSyntax.calls) {
      callCount += 1;
      if (filePath !== OWNING_FILE) {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, matchIndex),
          reason: `${PRODUCER_NAME} must be called only in ${OWNING_FILE}`,
        });
      }
    }
  }

  if (declarationCount !== 1) {
    violations.push({
      filePath: OWNING_FILE,
      lineNumber: 0,
      reason: `expected exactly 1 declaration of ${PRODUCER_NAME}, found ${declarationCount}`,
    });
  }
  if (callCount !== 1) {
    violations.push({
      filePath: OWNING_FILE,
      lineNumber: 0,
      reason: `expected exactly 1 call site of ${PRODUCER_NAME}, found ${callCount}`,
    });
  }

  return { callCount, declarationCount, violations };
}

async function main() {
  const { violations } = await findAssistantRunIdProducerViolations();

  if (violations.length === 0) {
    console.log(`Assistant runId provenance intact: one ${PRODUCER_NAME} producer.`);
    return;
  }

  console.error(
    'Assistant runId provenance is what keeps the main-process run-event writes safe ' +
      'against the bootstrap-only schema. See docs/agents/assistant-persistence.md ' +
      '§ RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP. Violations:'
  );
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.lineNumber} — ${violation.reason}`);
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
