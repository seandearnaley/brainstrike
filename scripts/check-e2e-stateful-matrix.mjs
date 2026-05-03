#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const e2eDir = path.join(rootDir, 'apps/web/e2e');
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');

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

function extractStatefulJob(workflowSource) {
  const start = workflowSource.search(/^  e2e-stateful:\s*$/m);
  if (start === -1) {
    throw new Error('Could not find e2e-stateful job in .github/workflows/test.yml');
  }

  const rest = workflowSource.slice(start + 1);
  const nextJob = rest.search(/\n  [a-zA-Z0-9_-]+:\s*$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

function formatList(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

const testFiles = await listTestFiles(e2eDir);
const statefulTaggedFiles = [];

for (const file of testFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes('@stateful')) {
    statefulTaggedFiles.push(path.relative(path.join(rootDir, 'apps/web'), file));
  }
}

const workflowSource = await readFile(workflowPath, 'utf8');
const statefulJobSource = extractStatefulJob(workflowSource);
const listedStatefulFiles = Array.from(
  new Set(statefulJobSource.match(/\be2e\/[^\s"'}]+\.test\.[cm]?[tj]sx?\b/g) ?? [])
).sort();

statefulTaggedFiles.sort();

const missingFromMatrix = statefulTaggedFiles.filter((file) => !listedStatefulFiles.includes(file));
const listedWithoutTag = listedStatefulFiles.filter((file) => !statefulTaggedFiles.includes(file));

if (missingFromMatrix.length > 0 || listedWithoutTag.length > 0) {
  console.error('E2E stateful matrix check failed.');
  console.error(
    '@stateful web E2E specs are excluded from the fast sharded job, so they must be listed in the e2e-stateful matrix.'
  );

  if (missingFromMatrix.length > 0) {
    console.error('\nTagged with @stateful but missing from e2e-stateful matrix:');
    console.error(formatList(missingFromMatrix));
  }

  if (listedWithoutTag.length > 0) {
    console.error('\nListed in e2e-stateful matrix but missing @stateful in the spec:');
    console.error(formatList(listedWithoutTag));
  }

  process.exit(1);
}

console.log('E2E stateful matrix check passed.');
