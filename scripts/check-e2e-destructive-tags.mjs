#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  findTaggedPlaywrightTitleRanges,
  isInsideRange,
  listTestFiles,
} from './e2e-playwright-title-tags.mjs';

const rootDir = process.cwd();
const e2eDirs = [path.join(rootDir, 'apps/web/e2e'), path.join(rootDir, 'apps/desktop/e2e')];

const destructiveFlowPatterns = [
  {
    label: 'factory reset selector or route',
    pattern: /\bfactory-reset\b/i,
  },
  {
    label: 'factory reset UI text',
    pattern: /\bFactory Reset\b/,
  },
];

function getLineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

const failures = [];

for (const e2eDir of e2eDirs) {
  for (const file of await listTestFiles(e2eDir)) {
    const source = await readFile(file, 'utf8');
    const destructiveTitleRanges = findTaggedPlaywrightTitleRanges(
      source,
      file,
      '@destructive'
    );

    for (const { label, pattern } of destructiveFlowPatterns) {
      const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const match of source.matchAll(globalPattern)) {
        if (typeof match.index !== 'number') {
          continue;
        }
        if (isInsideRange(match.index, destructiveTitleRanges)) {
          continue;
        }

        failures.push({
          file: path.relative(rootDir, file),
          label,
          line: getLineNumber(source, match.index),
        });
      }
    }
  }
}

if (failures.length > 0) {
  console.error('E2E destructive tag check failed.');
  console.error(
    'Factory-reset E2E flows must include @destructive in a Playwright test or describe title so they run in the isolated single-worker destructive job.'
  );
  for (const failure of failures) {
    console.error(`- ${failure.file}:${failure.line}: matched ${failure.label}`);
  }
  process.exit(1);
}

console.log('E2E destructive tag check passed.');
