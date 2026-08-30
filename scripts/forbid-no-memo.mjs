#!/usr/bin/env node

import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'scripts/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  '*.config.{js,cjs,mjs,ts,cts,mts}',
  'vitest.config.{js,cjs,mjs,ts,cts,mts}',
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

const forbiddenDirective = ['use', 'no', 'memo'].join(' '); // split to avoid self-match
const NO_MEMO_PATTERN = new RegExp(`^\\s*(['"])${forbiddenDirective}\\1;?\\s*$`, 'gm');

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

async function main() {
  const sourceFiles = (
    await Array.fromAsync(
      glob(SOURCE_PATTERNS, {
        exclude: IGNORE_PATTERNS,
        withFileTypes: true,
      })
    )
  )
    .filter((entry) => entry.isFile())
    // Windows: Node glob returns platform-separated paths by default, which
    // breaks the /-separated violation output consumers (and the test) match on.
    .map((entry) =>
      path
        .relative(process.cwd(), path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/')
    );

  const violations = (
    await Promise.all(
      sourceFiles.sort().map(async (filePath) => {
        const sourceText = await readFile(filePath, 'utf8');
        NO_MEMO_PATTERN.lastIndex = 0;

        const fileViolations = [];
        let match = NO_MEMO_PATTERN.exec(sourceText);
        while (match && match.index !== undefined) {
          fileViolations.push({
            filePath,
            lineNumber: getLineNumber(sourceText, match.index),
          });
          match = NO_MEMO_PATTERN.exec(sourceText);
        }

        return fileViolations;
      })
    )
  ).flat();

  if (violations.length === 0) {
    console.log('No forbidden React compiler escape directives found.');
    return;
  }

  console.error(
    'Forbidden React compiler escape directive found. Refactor around the React compiler instead.'
  );

  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.lineNumber}`);
  }

  process.exitCode = 1;
}

await main();
