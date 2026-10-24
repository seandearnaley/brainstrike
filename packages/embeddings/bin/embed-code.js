#!/usr/bin/env node

// Runs the CLI's TypeScript source; Node strips its types.
import { runEmbedCodeCli } from '../src/cli/embed-code.ts';

runEmbedCodeCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `embed-code failed: ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
