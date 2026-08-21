#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

const forbiddenDirective = ['use', 'no', 'memo'].join(' '); // split to avoid self-match
const NO_MEMO_PATTERN = new RegExp(`^\\s*(['"])${forbiddenDirective}\\1;?\\s*$`, 'gm');

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

export async function main() {
  const sourceFiles = await glob(SOURCE_PATTERNS, {
    absolute: false,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    // Windows: glob returns backslash-separated paths by default, which breaks
    // the /-separated violation output consumers (and the test) match on.
    posix: true,
  });

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

const isDirectExecution =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  await main();
}
