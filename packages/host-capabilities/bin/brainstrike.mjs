#!/usr/bin/env node

// BST-2246: first, before this process creates anything. The command runs its agent
// host in this process, so everything it creates is owned by the user even when an
// elevated token defaults to BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';

// Both command names delegate to the same parser, client and exit-code owner.
// The product executable composes the Core CLI with this package's platform,
// run from TypeScript source (Node strips its types).
import { enableCompileCache } from 'node:module';
import { fileURLToPath } from 'node:url';

// Node's on-disk compile cache, on before the CLI's module graph loads.
// https://nodejs.org/api/module.html#moduleenablecompilecachecachedir
enableCompileCache();

const platformModule = fileURLToPath(new URL('../src/platform.ts', import.meta.url));
const { runHostCliProcess } = await import('@brainstrike/agent-host/cli');
await runHostCliProcess(process.argv.slice(2), { platformModule });
