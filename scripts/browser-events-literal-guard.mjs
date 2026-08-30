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

import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
  '**/.nyc_output',
  '**/.nyc_output/**',
  '**/blob-report',
  '**/blob-report/**',
  '**/.stryker-tmp',
  '**/.stryker-tmp/**',
  '**/reports',
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
  for (const filePath of sourceFiles.sort()) {
    if (ALLOWED_FILES.has(filePath)) {
      continue;
    }
    const sourceText = await readFile(path.join(root, filePath), 'utf8');
    for (const eventName of GUARDED_EVENT_NAMES) {
      // Only QUOTED literals violate the contract — a code comment may
      // legitimately mention an event name (review round on #1793). The name
      // is matched with a quote character on each side (', ", or `).
      const quoted = new RegExp(
        `['"\`]${eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`,
        'g'
      );
      for (const match of sourceText.matchAll(quoted)) {
        violations.push({
          eventName,
          filePath,
          lineNumber: getLineNumber(sourceText, match.index),
        });
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
