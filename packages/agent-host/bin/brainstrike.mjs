#!/usr/bin/env node

// A tracked bin target lets pnpm install executable links before tsc emits dist.
// Both command names delegate to the same parser, client and exit-code owner.
const entry = new URL('../dist/cli.js', import.meta.url);
try {
  const { runHostCliProcess } = await import(entry.href);
  await runHostCliProcess(process.argv.slice(2));
} catch (cause) {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    cause.code === 'ERR_MODULE_NOT_FOUND' &&
    'url' in cause &&
    cause.url === entry.href
  ) {
    process.stderr.write(
      'Brainstrike CLI is not built. Run pnpm -w build --filter @brainstrike/agent-host.\n'
    );
    process.exitCode = 1;
  } else {
    throw cause;
  }
}
