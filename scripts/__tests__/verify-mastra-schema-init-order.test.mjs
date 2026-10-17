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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findMastraSchemaModuleScopeReads,
  findModuleScopeReadsInSource,
  readGuardedBindings,
  shouldScanSource,
} from '../verify-mastra-schema-init-order.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Includes DEFAULT_THREAD_TITLE on purpose: not every guarded constant has
// "mastra" in its name, which is what broke the original pre-filter.
const GUARDED = [
  'MASTRA_MEMORY_TABLES',
  'MASTRA_VECTOR_TABLE',
  'MASTRA_WORKFLOW_TABLE',
  'DEFAULT_THREAD_TITLE',
];

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

test('the pre-filter admits every guarded constant, including the non-"mastra" ones', async () => {
  const guardedNames = [...(await readGuardedBindings({ root: REPO_ROOT }))];

  for (const name of guardedNames) {
    assert.ok(
      shouldScanSource(`import { ${name} } from './sql';`, guardedNames),
      `A file importing ${name} must be parsed. The original pre-filter tested for a lower-case ` +
        '"mastra" substring, which skipped both the upper-case-only re-export modules and the ' +
        'THREAD_TITLE_* constants entirely — a silent false negative, not a slow path.'
    );
  }

  // A real module the substring pre-filter would skip unparsed: it imports a
  // guarded constant, and its TEXT contains no lower-case "mastra". (The
  // original fixture, pglite-mastra-memory/schema.ts, left with BST-2068.)
  const guardedImporter = readFileSync(
    path.join(REPO_ROOT, 'packages/host-capabilities/src/native-tools/manage-canvas-tool.ts'),
    'utf8'
  );
  assert.ok(
    !guardedImporter.includes('mastra'),
    'Fixture assumption broke: that module now contains a lower-case "mastra", so it no longer ' +
      'demonstrates the blind spot. Pick another module that imports a guarded constant.'
  );
  assert.ok(
    shouldScanSource(guardedImporter, guardedNames),
    'The guarded importer must be parsed by the guard.'
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
  // --- gaps closed after review on PR #1988. Each was a false NEGATIVE: the
  // guard reported clean on code that reads a constant at chunk-init time.
  {
    name: 'namespace import read by property (one `import * as` used to blind the whole file)',
    source: `import * as schema from '${CONTRACT}';\nconst SQL = \`SELECT \${schema.MASTRA_MEMORY_TABLES.threads}\`;\n`,
  },
  {
    name: 'default import read by property',
    source: `import schema from './sql.js';\nconst TABLE = schema.MASTRA_VECTOR_TABLE;\n`,
  },
  {
    name: 'module-scope IIFE (the "module-scope memo" shape the fix comments warn against)',
    source: `import { MASTRA_VECTOR_TABLE } from '${CONTRACT}';\nconst SQL = (() => \`SELECT \${MASTRA_VECTOR_TABLE}\`)();\n`,
  },
  {
    name: 'static class property initializer',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  static TABLE = MASTRA_WORKFLOW_TABLE;\n}\n`,
  },
  {
    name: 'static initialization block',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  static {\n    register(MASTRA_WORKFLOW_TABLE);\n  }\n}\n`,
  },
  {
    name: 'export default expression',
    source: `import { MASTRA_VECTOR_TABLE } from '${CONTRACT}';\nexport default \`SELECT \${MASTRA_VECTOR_TABLE}\`;\n`,
  },
  {
    name: 'top-level if statement',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nif (globalThis.flag) {\n  register(MASTRA_WORKFLOW_TABLE);\n}\n`,
  },
  {
    name: 'top-level try/catch',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\ntry {\n  register(MASTRA_WORKFLOW_TABLE);\n} catch {}\n`,
  },
  {
    name: 'top-level for loop',
    source: `import { MASTRA_MEMORY_TABLES } from '${CONTRACT}';\nfor (const t of Object.values(MASTRA_MEMORY_TABLES)) {\n  register(t);\n}\n`,
  },
  {
    name: 'a constant with no "mastra" in its name at all (the pre-filter blind spot)',
    source: `import { DEFAULT_THREAD_TITLE } from '${CONTRACT}';\nconst TITLE = DEFAULT_THREAD_TITLE;\n`,
  },
  // A computed KEY is evaluated once, at class-definition time — i.e. at module
  // init — whether or not the member is static. Same for decorators.
  {
    name: 'computed member name on an INSTANCE member (evaluated at class definition)',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  [MASTRA_WORKFLOW_TABLE] = 1;\n}\n`,
  },
  {
    name: 'computed member name on a static member',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  static [MASTRA_WORKFLOW_TABLE] = 1;\n}\n`,
  },
  {
    name: 'class decorator argument',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\n@register(MASTRA_WORKFLOW_TABLE)\nclass Store {}\n`,
  },
  {
    name: 'member decorator argument on an instance method',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  @register(MASTRA_WORKFLOW_TABLE)\n  clear() {}\n}\n`,
  },
  {
    name: 'object-literal computed key',
    source: `import { MASTRA_VECTOR_TABLE } from '${CONTRACT}';\nconst byTable = { [MASTRA_VECTOR_TABLE]: 1 };\n`,
  },
  // A RENAMED re-export defeats name matching for every downstream consumer, so
  // the rename itself is the violation.
  {
    name: 'renamed re-export (breaks name matching for every downstream consumer)',
    source: `export { MASTRA_VECTOR_TABLE as VECTORS } from './sql.js';\n`,
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
  // Controls for the statement kinds now walked. Broadening the walk must not
  // start flagging members and declarations that do NOT run at module init.
  {
    name: 'INSTANCE class property initializer (runs per construction, not at module init)',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  table = MASTRA_WORKFLOW_TABLE;\n}\n`,
  },
  {
    name: 'a top-level function declaration body',
    source: `import { MASTRA_MEMORY_TABLES } from '${CONTRACT}';\nexport function buildSql() {\n  return \`SELECT \${MASTRA_MEMORY_TABLES.threads}\`;\n}\n`,
  },
  {
    name: 'a re-export (links a binding, never reads one)',
    source: `export { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\n`,
  },
  {
    name: 'a namespace import whose guarded-looking property is read inside a function',
    source: `import * as schema from '${CONTRACT}';\nfunction build() {\n  return schema.MASTRA_VECTOR_TABLE;\n}\n`,
  },
  {
    name: 'a namespace import read for an UNguarded property at module scope',
    source: `import * as schema from '${CONTRACT}';\nconst other = schema.SOMETHING_ELSE;\n`,
  },
  {
    name: 'a SAME-name re-export (the supported hop — renaming is what breaks matching)',
    source: `export { MASTRA_VECTOR_TABLE, MASTRA_MEMORY_TABLES } from './sql.js';\n`,
  },
  {
    name: 'a local import alias at the point of use (the imported name is still spelled)',
    source: `import { MASTRA_VECTOR_TABLE as VECTORS } from './sql.js';\nfunction build() {\n  return \`SELECT \${VECTORS}\`;\n}\n`,
  },
  {
    name: 'a type-only renamed re-export (erased, never read at runtime)',
    source: `export type { MASTRA_VECTOR_TABLE as Vectors } from './sql.js';\n`,
  },
  {
    name: 'an instance method body under a computed guarded key',
    source: `import { MASTRA_WORKFLOW_TABLE } from '${CONTRACT}';\nclass Store {\n  clear() {\n    return MASTRA_WORKFLOW_TABLE;\n  }\n}\n`,
  },
];

test('the rename check reports its own reason, not the module-scope-read one', async () => {
  const guardedNames = [...(await readGuardedBindings({ root: REPO_ROOT }))];
  const [violation] = findModuleScopeReadsInSource(
    `export { MASTRA_VECTOR_TABLE as VECTORS } from './sql.js';\n`,
    guardedNames
  );

  assert.ok(violation, 'A renamed re-export of a guarded constant must be reported.');
  assert.equal(
    violation.rename,
    true,
    'The rename must be tagged so the CLI explains that name matching was broken, rather than ' +
      'telling the author to "move the read inside a function" — there is no read here.'
  );
});

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
