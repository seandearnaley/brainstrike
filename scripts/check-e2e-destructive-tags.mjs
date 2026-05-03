#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const e2eDir = path.join(rootDir, 'apps/web/e2e');

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

const destructiveTitlePattern =
  /\btest(?:\.describe)?(?:\.(?:only|serial|skip|fixme))?\s*\(\s*(["'`])[^"'`]*@destructive[^"'`]*\1/g;

function getLineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function findMatchingBlockEnd(source, blockStart) {
  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return source.length;
}

function findDestructiveTitleRanges(source) {
  const ranges = [];
  destructiveTitlePattern.lastIndex = 0;

  for (const match of source.matchAll(destructiveTitlePattern)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    const blockStart = source.indexOf('{', match.index + match[0].length);
    if (blockStart === -1) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
      continue;
    }

    ranges.push({ start: match.index, end: findMatchingBlockEnd(source, blockStart) });
  }

  return ranges;
}

function isInsideDestructiveTitleRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

async function listTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listTestFiles(fullPath);
      }
      if (entry.isFile() && /\.test\.[cm]?[tj]sx?$/.test(entry.name)) {
        return [fullPath];
      }
      return [];
    })
  );

  return files.flat();
}

const failures = [];

for (const file of await listTestFiles(e2eDir)) {
  const source = await readFile(file, 'utf8');
  const destructiveTitleRanges = findDestructiveTitleRanges(source);

  for (const { label, pattern } of destructiveFlowPatterns) {
    const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of source.matchAll(globalPattern)) {
      if (typeof match.index !== 'number') {
        continue;
      }
      if (isInsideDestructiveTitleRange(match.index, destructiveTitleRanges)) {
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
