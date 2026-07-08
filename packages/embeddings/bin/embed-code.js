#!/usr/bin/env node

// Shim to run the built CLI when available.
// This file exists so that package managers can safely create the bin during install,
// before the TypeScript sources are compiled into dist/.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const cjsEntrypoint = resolve(__dirname, '../dist/cli/embed-code.js');
const esmEntrypoint = resolve(__dirname, '../dist/cli/embed-code.mjs');

async function main() {
  if (existsSync(cjsEntrypoint)) {
    // CommonJS build
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    requireOrExit(() => req(cjsEntrypoint));
    return;
  }
  if (existsSync(esmEntrypoint)) {
    // ESM build
    const url = pathToFileURL(esmEntrypoint).href;
    await import(url);
    return;
  }
  process.exit(1);
}

function requireOrExit(fn) {
  try {
    fn();
  } catch {
    process.exit(1);
  }
}

main().catch((_err) => {
  process.exit(1);
});
