#!/usr/bin/env node

// Both command names delegate to the same parser, client and exit-code owner.
// The product executable composes the Core CLI with this package's platform,
// run from TypeScript source (Node strips its types).
import { fileURLToPath } from 'node:url';

const platformModule = fileURLToPath(new URL('../src/platform.ts', import.meta.url));
const { runHostCliProcess } = await import('@brainstrike/agent-host/cli');
await runHostCliProcess(process.argv.slice(2), { platformModule });
