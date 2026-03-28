#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { glob } from 'glob';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'scripts/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  '*.config.{js,cjs,mjs,ts,cts,mts}',
  'vitest.config.{js,cjs,mjs,ts,cts,mts}',
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

const forbiddenDirective = ['use', 'no', 'memo'].join(' ');
const NO_MEMO_PATTERN = new RegExp(`(['"])${forbiddenDirective}\\1`);

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

async function main() {
  const sourceFiles = await glob(SOURCE_PATTERNS, {
    absolute: false,
    ignore: IGNORE_PATTERNS,
    nodir: true,
  });

  const violations = [];

  for (const filePath of sourceFiles.sort()) {
    const sourceText = await readFile(filePath, 'utf8');
    const match = NO_MEMO_PATTERN.exec(sourceText);

    if (!match || match.index === undefined) {
      continue;
    }

    violations.push({
      filePath,
      lineNumber: getLineNumber(sourceText, match.index),
    });
  }

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
