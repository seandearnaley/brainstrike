#!/usr/bin/env node

// Shim to run the built CLI when available.
// This file exists so that package managers can safely create the bin during install,
// before the TypeScript sources are compiled into dist/.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const entrypoint = resolve(__dirname, '../dist/cli/embed-code.js');

async function main() {
  if (!existsSync(entrypoint)) {
    throw new Error(`Built embed-code entrypoint is missing: ${entrypoint}`);
  }
  const builtModule = await import(pathToFileURL(entrypoint).href);
  if (typeof builtModule.runEmbedCodeCli !== 'function') {
    throw new TypeError(
      `Built embed-code entrypoint does not export runEmbedCodeCli: ${entrypoint}`
    );
  }
  await builtModule.runEmbedCodeCli(process.argv.slice(2));
}

main().catch((error) => {
  process.stderr.write(
    `embed-code failed: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
