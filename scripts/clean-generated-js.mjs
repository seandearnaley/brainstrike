#!/usr/bin/env node
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2);

for (const root of roots) {
  removeGeneratedFiles(root);
}

function removeGeneratedFiles(directory) {
  let entries;

  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const filePath = join(directory, entry);
    const stats = statSync(filePath);

    if (stats.isDirectory()) {
      removeGeneratedFiles(filePath);
      continue;
    }

    if (entry.endsWith('.js') || entry.endsWith('.js.map')) {
      rmSync(filePath, { force: true });
    }
  }
}
