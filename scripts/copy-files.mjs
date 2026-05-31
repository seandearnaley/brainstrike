#!/usr/bin/env node
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);

if (args.length % 2 !== 0) {
  console.error('Usage: node scripts/copy-files.mjs <source> <target> [...]');
  process.exit(1);
}

for (let index = 0; index < args.length; index += 2) {
  const source = args[index];
  const target = args[index + 1];

  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
