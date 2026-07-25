import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Pins the `mastra_workflow_snapshot` literal in the RENDERER-side reset path to
 * `MASTRA_WORKFLOW_TABLE`, without importing the contract package there.
 *
 * WHY A LITERAL AT ALL: `clearWorkflowSnapshotsIfPresent` probes with
 * `to_regclass`, which returns NULL for an absent relation instead of raising —
 * that is what stops a missing table from aborting the enclosing transaction.
 * The cost is that a STALE name is indistinguishable from an absent table: the
 * reset path would skip forever with no error, no warn, only a `logger.debug`,
 * and every test would stay green because they all hardcode the same wrong name.
 *
 * WHY NOT JUST IMPORT THE CONSTANT: that was tried and it broke the app.
 * `packages/db/src/db-provider.tsx` is renderer-side. Adding
 * `import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema'`
 * reorders bundle chunk initialization so `MASTRA_MEMORY_TABLES` is undefined by
 * the time `packages/app-shell/src/assistant-memory-repository.ts` evaluates its
 * MODULE-SCOPE SQL template literals (`${MASTRA_MEMORY_TABLES.threads}`). The
 * renderer dies with "Cannot read properties of undefined (reading 'threads')"
 * and the app never becomes ready.
 *
 * Measured on this branch, not theorised: commit `df953a2a8` (literal) had Web
 * E2E and Desktop E2E green; `3e8d1b7fd` (identical except for the import) turned
 * both red with that exact renderer crash. The schema module itself imports
 * nothing, so this is a bundling/init-order effect, not a source cycle — which is
 * why type-check and every unit suite stayed green through it.
 *
 * So the literal stays and this test carries the guarantee instead. It is the
 * same protection with no runtime import edge. `apps/desktop/src/ipc-domains/db-ipc.ts`
 * is Electron MAIN, not renderer, and keeps the real import.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCHEMA_SOURCE = path.join(
  repoRoot,
  'packages/assistant-contract/src/mastra-memory-schema.ts'
);
const RENDERER_SOURCE = path.join(repoRoot, 'packages/db/src/db-provider.tsx');

/** `MASTRA_WORKFLOW_TABLE` resolved from the contract source, via its backing const. */
function contractWorkflowTableName() {
  const source = readFileSync(SCHEMA_SOURCE, 'utf8');
  const exported = source.match(/export const MASTRA_WORKFLOW_TABLE\s*=\s*([A-Za-z_$][\w$]*)\s*;/);
  assert.ok(
    exported,
    `Could not find "export const MASTRA_WORKFLOW_TABLE = <ident>;" in ${path.relative(repoRoot, SCHEMA_SOURCE)}. ` +
      'If it is now declared differently, teach this guard the new shape rather than deleting it.'
  );
  const backing = source.match(new RegExp(`const ${exported[1]}\\s*=\\s*'([^']+)'`));
  assert.ok(
    backing,
    `Found MASTRA_WORKFLOW_TABLE = ${exported[1]}, but no "const ${exported[1]} = '<name>'" backing it.`
  );
  return backing[1];
}

test('the literal in the renderer reset path equals MASTRA_WORKFLOW_TABLE', () => {
  const expected = contractWorkflowTableName();
  const source = readFileSync(RENDERER_SOURCE, 'utf8');

  // Anchored on the NAMED const, not a positional `const table = '…'` match:
  // this file has more than one of those (clearToolOutputArtifactsIfPresent has
  // its own), and the first-match version of this guard compared the wrong one
  // and failed on a correct tree. Caught by its own control test.
  const assigned = source.match(/const WORKFLOW_SNAPSHOT_TABLE = '([^']+)'/);
  assert.ok(
    assigned,
    `Could not find "const WORKFLOW_SNAPSHOT_TABLE = '<name>'" in ${path.relative(repoRoot, RENDERER_SOURCE)}. ` +
      'clearWorkflowSnapshotsIfPresent must keep naming the table via that const so this guard can check it.'
  );

  assert.equal(
    assigned[1],
    expected,
    `The renderer reset path clears "${assigned[1]}" but the contract says the table is "${expected}". ` +
      'Because that path probes with to_regclass (which returns NULL rather than raising), a stale name is a ' +
      'PERMANENT SILENT SKIP: reset would quietly stop clearing suspended workflow snapshots, with no error and ' +
      'no failing test anywhere else.'
  );
});

test('the renderer reset path does NOT import the contract package', () => {
  // Guards the regression this literal exists to avoid. See the header: the
  // import reorders chunk init and kills the renderer at startup, and it does so
  // WITHOUT failing type-check or any unit suite — only E2E catches it.
  const source = readFileSync(RENDERER_SOURCE, 'utf8');
  assert.doesNotMatch(
    source,
    /^import\s[^;]*from\s+'@brainstrike\/assistant-contract/m,
    `${path.relative(repoRoot, RENDERER_SOURCE)} imports @brainstrike/assistant-contract. That is renderer-side ` +
      'and reorders bundle chunk init so MASTRA_MEMORY_TABLES is undefined when assistant-memory-repository.ts ' +
      'evaluates its module-scope SQL — the renderer then dies with "Cannot read properties of undefined ' +
      "(reading 'threads')\" and the app never becomes ready. Reproduced on commit 3e8d1b7fd. Keep the literal " +
      'and let the test above pin it to the constant.'
  );
});
