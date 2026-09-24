import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';

// Use the same source registry as Vitest; this probe must never require dist.
const aliases = workspaceSrcAliases(fileURLToPath(new URL('../../../', import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const sourcePath = resolveThroughAliases(specifier, aliases);
    return nextResolve(sourcePath ? pathToFileURL(sourcePath).href : specifier, context);
  },
});
// Node loads undici on first access to a web global such as `FormData`, and
// undici reads `performance.markResourceTiming` while loading. Effect Schema
// reads `globalThis.FormData` at import, so load undici while `performance`
// still exists; this probe is about the database package's own clock reads.
void globalThis.FormData;
globalThis.performance = undefined;
const { databaseQueryTelemetry } = await import('../../src/index.ts');
assert.throws(
  () => databaseQueryTelemetry.snapshot(),
  /Database query telemetry requires the Performance monotonic clock/
);
