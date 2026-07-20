#!/usr/bin/env node

// Guard: the cross-package window CustomEvent names for the embedding queue
// ('queue-drained' / 'queue-progress' / 'embedding-set-updated') are a wire
// contract owned by packages/utils/src/browser-events.ts (BST-580). Before that
// module existed, three packages dispatched 'queue-drained' with divergent
// detail shapes; a listener written against one shape silently misread the
// others. Spelling an event name as a string literal outside the shared module
// (and its own unit test, which pins the wire format) reintroduces exactly that
// drift, so this guard fails the lint lane on any stray literal — import the
// constants / dispatch helpers / listen helpers from
// '@brainstrike/utils/browser-events' instead.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Built via join so this script does not match itself.
const GUARDED_EVENT_NAMES = ['queue-drained', 'queue-progress', 'embedding-set-updated'].map(
  (suffix) => ['brainstrike', suffix].join(':')
);

// The only files allowed to spell the guarded literals (posix-relative paths).
const ALLOWED_FILES = new Set([
  'packages/utils/src/__tests__/browser-events.test.ts',
  'packages/utils/src/browser-events.ts',
]);

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'scripts/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
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
  '**/.nyc_output/**',
  '**/blob-report/**',
  '**/.stryker-tmp/**',
  '**/reports/**',
];

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

/**
 * Scan a source tree for guarded event-name literals outside the allowlist.
 * Returns `{ filePath, lineNumber, eventName }` violations sorted by path.
 */
export async function findBrowserEventLiteralViolations({ root = REPO_ROOT } = {}) {
  const sourceFiles = await glob(SOURCE_PATTERNS, {
    absolute: false,
    cwd: root,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    posix: true,
  });

  const violations = [];
  for (const filePath of sourceFiles.sort()) {
    if (ALLOWED_FILES.has(filePath)) {
      continue;
    }
    const sourceText = await readFile(path.join(root, filePath), 'utf8');
    for (const eventName of GUARDED_EVENT_NAMES) {
      let matchIndex = sourceText.indexOf(eventName);
      while (matchIndex !== -1) {
        violations.push({
          eventName,
          filePath,
          lineNumber: getLineNumber(sourceText, matchIndex),
        });
        matchIndex = sourceText.indexOf(eventName, matchIndex + eventName.length);
      }
    }
  }
  return violations;
}

async function main() {
  const violations = await findBrowserEventLiteralViolations();

  if (violations.length === 0) {
    console.log('No stray brainstrike browser-event literals found.');
    return;
  }

  console.error(
    'Brainstrike browser-event names must come from @brainstrike/utils/browser-events ' +
      '(constants or dispatch/listen helpers), not string literals:'
  );
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.lineNumber} (${violation.eventName})`);
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
