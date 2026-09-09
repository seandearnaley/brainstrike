import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';

// Use the same source registry as Vitest; this probe must never require dist.
const aliases = workspaceSrcAliases(fileURLToPath(new URL('../../../', import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(resolveThroughAliases(specifier, aliases) ?? specifier, context);
  },
});
globalThis.performance = undefined;
const { databaseQueryTelemetry } = await import('../../src/index.ts');
assert.throws(
  () => databaseQueryTelemetry.snapshot(),
  /Database query telemetry requires the Performance monotonic clock/
);
