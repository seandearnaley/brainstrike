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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCER_NAME = 'createThreadRunId';
const OWNING_FILE = 'packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.turbo/**',
  '**/build/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/.vite/**',
  '**/blob-report/**',
  '**/reports/**',
  // Tests may reference the producer freely; they cannot introduce a
  // production request path.
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/e2e/**',
];

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

/**
 * Scan non-test source for references to the run-id producer.
 * Returns `{ violations, declarationCount, callCount }`; violations carry
 * `{ filePath, lineNumber, reason }`.
 */
export async function findAssistantRunIdProducerViolations({ root = REPO_ROOT } = {}) {
  const sourceFiles = await glob(SOURCE_PATTERNS, {
    absolute: false,
    cwd: root,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    posix: true,
  });

  const violations = [];
  let declarationCount = 0;
  let callCount = 0;

  const declaration = new RegExp(`function\\s+${PRODUCER_NAME}\\s*\\(`, 'g');
  const call = new RegExp(`(?<!function\\s)\\b${PRODUCER_NAME}\\s*\\(`, 'g');
  const exported = new RegExp(`export\\s+(?:async\\s+)?function\\s+${PRODUCER_NAME}\\b`, 'g');

  for (const filePath of sourceFiles.sort()) {
    const sourceText = await readFile(path.join(root, filePath), 'utf8');
    if (!sourceText.includes(PRODUCER_NAME)) {
      continue;
    }

    for (const match of sourceText.matchAll(declaration)) {
      declarationCount += 1;
      if (filePath !== OWNING_FILE) {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, match.index),
          reason: `${PRODUCER_NAME} must be declared only in ${OWNING_FILE}`,
        });
      }
    }

    for (const match of sourceText.matchAll(exported)) {
      violations.push({
        filePath,
        lineNumber: getLineNumber(sourceText, match.index),
        reason: `${PRODUCER_NAME} must stay module-private (exporting it lets another module mint a runId)`,
      });
    }

    for (const match of sourceText.matchAll(call)) {
      callCount += 1;
      if (filePath !== OWNING_FILE) {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, match.index),
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
