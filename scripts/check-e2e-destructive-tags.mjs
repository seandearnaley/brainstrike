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
  if (/@destructive\b/.test(source)) {
    continue;
  }

  for (const { label, pattern } of destructiveFlowPatterns) {
    if (pattern.test(source)) {
      failures.push({ file: path.relative(rootDir, file), label });
      break;
    }
  }
}

if (failures.length > 0) {
  console.error('E2E destructive tag check failed.');
  console.error(
    'Factory-reset E2E flows must include @destructive so they run in the isolated single-worker destructive job.'
  );
  for (const failure of failures) {
    console.error(`- ${failure.file}: matched ${failure.label}`);
  }
  process.exit(1);
}

console.log('E2E destructive tag check passed.');
