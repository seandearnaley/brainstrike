// Paired test for scripts/verify-mastra-schema-init-order.mjs (BST-558).
//
// The guard's own header carries the full history. What matters here: this
// defect class is invisible to `tsc`, to lint, and to every unit suite — it
// needs a production chunk graph to appear — so this guard is the only thing
// standing between a one-line import and a renderer that never boots. A guard
// like that must be CONTROL-TESTED, not merely observed passing: a detector that
// cannot go red reads exactly like one that can (BST-836).
//
// So the detection cases below are not decoration. Each is a syntax form the
// superseded stopgap could not see:
//   - the module-scope const the stopgap protected by hand-copying a literal,
//   - a template interpolation (the shape of the measured crash),
//   - a re-export hop under a different specifier and a local alias,
//   - `export const`, which the stopgap's import-shaped regex missed entirely.
//
// The false-positive controls matter just as much. The fix for this defect is to
// move the read inside a function, and a guard that flagged that too would push
// people straight back to hand-copied literals — the thing being removed.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findMastraSchemaModuleScopeReads,
  findModuleScopeReadsInSource,
  readGuardedBindings,
} from '../verify-mastra-schema-init-order.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const GUARDED = ['MASTRA_MEMORY_TABLES', 'MASTRA_VECTOR_TABLE', 'MASTRA_WORKFLOW_TABLE'];

const CONTRACT = '@brainstrike/assistant-contract/mastra-memory-schema';

test('the guarded names are scraped from the schema module, not hand-listed', async () => {
  const guarded = await readGuardedBindings({ root: REPO_ROOT });

  // Anti-vacuous floor: an empty scrape would make every violation check pass.
  assert.ok(
    guarded.size >= 5,
    `Scraped only ${guarded.size} constants from the schema module; the guard would check almost nothing.`
  );
  for (const name of GUARDED) {
    assert.ok(guarded.has(name), `Expected ${name} to be scraped from the schema module.`);
  }
});

test('VERDICT: the repository has no module-scope reads of the schema constants', async () => {
  const violations = await findMastraSchemaModuleScopeReads({ root: REPO_ROOT });

  assert.deepEqual(
    violations.map((v) => `${v.filePath}:${v.line} (${v.binding})`),
    [],
    'Module-scope reads of mastra-memory-schema constants are back. Bundle chunk order does not ' +
      'guarantee the contract chunk has initialized then, so the binding can be undefined: a ' +
      'property access kills the renderer at startup and a bare interpolation splices "undefined" ' +
      'into SQL. Move the read inside the function that uses it.'
  );
});

test('an unreadable tree refuses loudly instead of reporting a vacuous pass', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst558-empty-root-'));

  await assert.rejects(
    () => findMastraSchemaModuleScopeReads({ root: emptyRoot }),
    /no verdict is possible/,
    'An empty tree must throw. Silently returning zero violations would let this guard report ' +
      'success on any tree it failed to read.'
  );
});

test('a readable tree with too few sources still refuses (the file-discovery floor)', async () => {
  // Distinct from the case above: the schema module IS readable here, so the
  // guarded set resolves and only file discovery comes up short. Without this
  // floor a mis-typed glob would scan nothing and report a clean bill of health.
  const sparseRoot = mkdtempSync(path.join(os.tmpdir(), 'bst558-sparse-root-'));
  const schemaDir = path.join(sparseRoot, 'packages', 'assistant-contract', 'src');
  mkdirSync(schemaDir, { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, 'packages/assistant-contract/src/mastra-memory-schema.ts'),
    path.join(schemaDir, 'mastra-memory-schema.ts')
  );

  await assert.rejects(
    () => findMastraSchemaModuleScopeReads({ root: sparseRoot }),
    /below the floor of/,
    'A tree with almost no sources must throw rather than report zero violations.'
  );
});

// --- detection controls: each of these must be caught -----------------------

const DETECTED = [
  {
    name: 'module-scope const (the shape the stopgap hand-copied a literal to avoid)',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nconst TABLE = MASTRA_WORKFLOW_TABLE;\n`,
  },
  {
    name: 'template interpolation of a property access (the measured crash)',
    source: `import { MASTRA_MEMORY_TABLES } from '${CONTRACT}';\nconst SQL = \`SELECT * FROM \${MASTRA_MEMORY_TABLES.threads}\`;\n`,
  },
  {
    name: 'bare template interpolation (splices the string "undefined" into SQL)',
    source: `import { MASTRA_VECTOR_TABLE } from '${CONTRACT}';\nconst SQL = \`CREATE TABLE \${MASTRA_VECTOR_TABLE} ()\`;\n`,
  },
  {
    name: 're-export hop under a local specifier and an alias',
    source: `import { MASTRA_VECTOR_TABLE as VECTORS } from './sql.js';\nconst SQL = \`SELECT \${VECTORS}\`;\n`,
  },
  {
    name: 'export const (invisible to the stopgap regex)',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nexport const TABLE = MASTRA_WORKFLOW_TABLE;\n`,
  },
  {
    name: 'spread into a module-scope collection',
    source: `import { MASTRA_MEMORY_TABLES } from '${CONTRACT}';\nconst ALL = new Set(Object.values(MASTRA_MEMORY_TABLES));\n`,
  },
  {
    name: 'top-level expression statement (a side-effecting registration call)',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nregister(MASTRA_WORKFLOW_TABLE);\n`,
  },
];

for (const { name, source } of DETECTED) {
  test(`detects: ${name}`, () => {
    const reads = findModuleScopeReadsInSource(source, GUARDED);
    assert.ok(reads.length > 0, `Expected a module-scope read to be reported for: ${name}`);
  });
}

// --- false-positive controls: each of these must be allowed ----------------
//
// If any of these ever start failing, the guard is telling people the FIX is a
// violation, and the only way out is the hand-copied literal this work removed.

const ALLOWED = [
  {
    name: 'read inside a function body (THE prescribed fix)',
    source: `import { MASTRA_MEMORY_TABLES } from '${CONTRACT}';\nfunction buildSql() {\n  return \`SELECT * FROM \${MASTRA_MEMORY_TABLES.threads}\`;\n}\n`,
  },
  {
    name: 'read inside an arrow function assigned at module scope',
    source: `import { MASTRA_VECTOR_TABLE } from '${CONTRACT}';\nconst buildSql = () => \`SELECT \${MASTRA_VECTOR_TABLE}\`;\n`,
  },
  {
    name: 'read inside a class method',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  clear() {\n    return MASTRA_WORKFLOW_TABLE;\n  }\n}\n`,
  },
  {
    name: 'read inside a lazily-memoized getter',
    source: `import { MASTRA_MEMORY_TABLES } from '${CONTRACT}';\nlet cached;\nfunction tables() {\n  cached ??= MASTRA_MEMORY_TABLES.threads;\n  return cached;\n}\n`,
  },
  {
    name: 'type-only import of the same name',
    source: `import type { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nconst x: typeof MASTRA_WORKFLOW_TABLE = 'mastra_workflow_snapshot';\n`,
  },
  {
    name: 'an unrelated local binding that merely shares the name',
    source: `const MASTRA_WORKFLOW_TABLE = 'something_local';\nconst TABLE = MASTRA_WORKFLOW_TABLE;\n`,
  },
  {
    name: 'the name appearing as a property key rather than a binding read',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nconst config = { MASTRA_WORKFLOW_TABLE: 1 };\nfunction use() {\n  return MASTRA_WORKFLOW_TABLE;\n}\n`,
  },
];

for (const { name, source } of ALLOWED) {
  test(`allows: ${name}`, () => {
    const reads = findModuleScopeReadsInSource(source, GUARDED);
    assert.deepEqual(
      reads,
      [],
      `Expected NO violation for: ${name}. Flagging this pushes callers back to hand-copied ` +
        'literals, which is the failure mode this guard replaced.'
    );
  });
}
