#!/usr/bin/env node

// A tracked bin target lets pnpm install executable links before tsc emits dist.
// Both command names delegate to the same parser, client and exit-code owner.
// The product executable composes the Core CLI with this package's platform.
import { existsSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { fileURLToPath } from 'node:url';

// Node's on-disk compile cache, on before the CLI's module graph loads.
// https://nodejs.org/api/module.html#moduleenablecompilecachecachedir
enableCompileCache();

const platformModule = fileURLToPath(new URL('../dist/platform.js', import.meta.url));
if (existsSync(platformModule)) {
  const { runHostCliProcess } = await import('@brainstrike/agent-host/cli');
  await runHostCliProcess(process.argv.slice(2), { platformModule });
} else {
  process.stderr.write(
    'Brainstrike CLI is not built. Run pnpm -w build --filter @brainstrike/host-capabilities.\n'
  );
  process.exitCode = 1;
}
