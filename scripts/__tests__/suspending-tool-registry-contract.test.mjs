import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A tool that can `suspend()` (declares a Mastra `suspendSchema`) but has no
 * REGISTERED typed resume UI pauses a run this build cannot answer. That
 * direction has no compile-time guard — `REGISTERED_SUSPEND_RESUME_TOOL_IDS`
 * only guarantees registry → UI — so this source scan is the only thing catching
 * it. Its blind spots therefore matter more than usual, and the control tests
 * below prove it actually catches what its failure message promises:
 *
 * - RECURSIVE: a suspending tool in a subdirectory must not be invisible.
 * - BOTH ROOTS: suspending tools are DEFINED in packages/agent/src/tools but
 *   REGISTERED in apps/desktop/src/assistant-server, which also defines tools of
 *   its own (retrieval-tool.ts, hybrid-search-tool.ts). Scanning one root only
 *   would miss a suspending tool defined in the other.
 * - LOOSE TOKEN: `/\bsuspendSchema\b/`, not `/\bsuspendSchema\s*:/`, so the
 *   property shorthand `{ suspendSchema }` and a spread of a shared config
 *   object are both caught.
 * - COMMENTS STRIPPED: prose mentioning suspendSchema (assistant-tools.ts has
 *   one) must not read as a declaration, or the guard turns into noise and gets
 *   silenced.
 * - ROOTS GUARDED: the root list itself was the fifth blind spot of the same
 *   shape (review of PR #1977). `walkTypeScriptFiles` swallows a missing
 *   directory, so renaming a declaration root would have silently dropped that
 *   whole root while the deep-equal still passed on the other one. Two defences
 *   now: the declaration roots are asserted to exist and be non-empty, AND a
 *   REPO-WIDE sweep (`REPO_SWEEP_ROOTS`) means a suspending tool defined in a
 *   brand-new package is caught even though it is under no declaration root.
 *
 * KNOWN LIMITATION (deliberate, harmless today): `stripComments` has no
 * string-literal awareness, so a line containing a URL has everything after the
 * `//` removed. A `suspendSchema` token AFTER a `//` inside a string on the same
 * line would therefore be missed. Documented so a future false negative is
 * debuggable rather than mysterious.
 *
 * Lives here rather than in a package test because it reads across packages —
 * a package-scoped vitest reading a foreign package's source is an unhashed
 * turbo input (stale-green cache landmine). `pnpm test:scripts` is uncached.
 */

/**
 * Where suspending tools are DEFINED. A token hit here is a declaration, so
 * these roots drive the exact-match contract below.
 */
const SUSPENDING_TOOL_SOURCE_ROOTS = [
  'packages/agent/src/tools',
  'apps/desktop/src/assistant-server',
];

/**
 * The whole first-party source tree. Scanned separately because the token alone
 * cannot tell a DECLARATION from a CONSUMER that merely reads the property, and
 * consumers legitimately live outside the declaration roots. The sweep's job is
 * only to ensure no root can be forgotten: every hit must be a known declaration
 * or an explicitly acknowledged non-declaring module. ~0.7s over ~1.9k files.
 */
const REPO_SWEEP_ROOTS = ['apps', 'packages'];

/** The only modules allowed to declare a `suspendSchema`, repo-relative. */
const REGISTERED_SUSPENDING_TOOL_MODULES = [
  'packages/agent/src/tools/ask-user-tool.ts',
  'packages/agent/src/tools/run-python-tool.ts',
  'packages/agent/src/tools/submit-plan-tool.ts',
];

/**
 * Modules that mention `suspendSchema` in code without declaring one — they READ
 * the property to detect suspending tools structurally. Listed explicitly so the
 * repo-wide sweep stays exact: a new entry here is a deliberate human decision,
 * never a silent widening.
 */
const ACKNOWLEDGED_NON_DECLARING_MODULES = [
  // (permission-tool-gate.ts left this list at the @mastra/core 1.56 idiom
  // adoption: the self-approving exception it read hasSuspendSchema for is
  // gone — every ask tool takes the requireApproval clone.)
  'packages/agent/src/permissions/plan-mode-tool-gate.ts',
];

const SUSPEND_SCHEMA_TOKEN = /\bsuspendSchema\b/;

/** Remove block and line comments so prose never reads as a declaration. */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

/**
 * Directories with no first-party source to scan. `dist`/`build`/`out` would
 * also re-flag a compiled copy of a real declaration under a second path.
 */
const PRUNED_DIRECTORIES = new Set([
  '__tests__',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'release',
  'test-results',
]);

function walkTypeScriptFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PRUNED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walkTypeScriptFiles(full, out);
      continue;
    }
    if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.(test|spec)\.[^.]+$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative paths of modules declaring a `suspendSchema`, sorted. */
function findSuspendingToolModules(repoRoot, roots = SUSPENDING_TOOL_SOURCE_ROOTS) {
  const files = [];
  for (const root of roots) {
    walkTypeScriptFiles(path.join(repoRoot, root), files);
  }
  return files
    .filter((file) => SUSPEND_SCHEMA_TOKEN.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
    .sort();
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function withWorkspace(run) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'brainstrike-suspending-tools-'));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function writeSource(workspace, relativePath, source) {
  const full = path.join(workspace, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, source);
}

test('every declaration root is present and non-empty', () => {
  // `walkTypeScriptFiles` returns [] for a missing directory, so without this a
  // renamed root would silently stop being covered while the contract below
  // still passed on whatever the OTHER root happened to contain.
  for (const root of [...SUSPENDING_TOOL_SOURCE_ROOTS, ...REPO_SWEEP_ROOTS]) {
    const files = walkTypeScriptFiles(path.join(repoRoot, root), []);
    assert.ok(
      files.length > 0,
      `Scan root "${root}" resolved to no TypeScript files. It was renamed, moved, or ` +
        'deleted — update the root list, or this guard silently stops covering it.'
    );
  }
});

test('the repo-wide sweep finds no suspendSchema outside the known modules', () => {
  // Closes the "defined outside the declaration roots" blind spot: a suspending
  // tool in a new package, a persona toolset, or anywhere else fails HERE even
  // though the exact-match contract below never looks there.
  assert.deepEqual(
    findSuspendingToolModules(repoRoot, REPO_SWEEP_ROOTS),
    [...REGISTERED_SUSPENDING_TOOL_MODULES, ...ACKNOWLEDGED_NON_DECLARING_MODULES].sort(),
    'A module outside the known set mentions `suspendSchema`. If it DECLARES one it is a ' +
      'suspending tool: register it in REGISTERED_SUSPEND_RESUME_TOOL_IDS with a typed ' +
      'AssistantToolSuspendNotice branch, move it under a declaration root, and add it to ' +
      'REGISTERED_SUSPENDING_TOOL_MODULES. If it only READS the property, add it to ' +
      'ACKNOWLEDGED_NON_DECLARING_MODULES.'
  );
});

test('every suspendSchema-declaring module under the tool roots has a registered resume UI', () => {
  assert.deepEqual(
    findSuspendingToolModules(repoRoot),
    REGISTERED_SUSPENDING_TOOL_MODULES,
    'A tool declaring a Mastra `suspendSchema` can pause a run. If it is not in ' +
      'REGISTERED_SUSPEND_RESUME_TOOL_IDS (@brainstrike/assistant-contract/tool-suspend) ' +
      'with a typed branch in AssistantToolSuspendNotice, every pause it raises is ' +
      'recorded as unanswerable and the user gets a dead end. Register the tool, then ' +
      'add its module to REGISTERED_SUSPENDING_TOOL_MODULES here.'
  );
});

test('CONTROL: catches a suspending tool in a SUBDIRECTORY of a scanned root', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(
      workspace,
      'packages/agent/src/tools/nested/deep/rogue-tool.ts',
      'export const rogueTool = { suspendSchema: RogueSuspendSchema };\n'
    );
    assert.deepEqual(findSuspendingToolModules(workspace), [
      'packages/agent/src/tools/nested/deep/rogue-tool.ts',
    ]);
  });
});

test('CONTROL: catches the property SHORTHAND form { suspendSchema }', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(
      workspace,
      'packages/agent/src/tools/shorthand-tool.ts',
      'const suspendSchema = z.object({});\nexport const t = createTool({ suspendSchema });\n'
    );
    assert.deepEqual(findSuspendingToolModules(workspace), [
      'packages/agent/src/tools/shorthand-tool.ts',
    ]);
  });
});

test('CONTROL: catches a suspending tool defined in the DESKTOP assistant-server root', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(
      workspace,
      'apps/desktop/src/assistant-server/desktop-suspending-tool.ts',
      'export const t = createTool({ ...sharedSuspendConfig, suspendSchema: S });\n'
    );
    assert.deepEqual(findSuspendingToolModules(workspace), [
      'apps/desktop/src/assistant-server/desktop-suspending-tool.ts',
    ]);
  });
});

test('CONTROL: the repo sweep catches a suspending tool defined OUTSIDE every declaration root', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(
      workspace,
      'packages/some-new-package/src/tools/rogue-tool.ts',
      'export const t = createTool({ suspendSchema: S });\n'
    );
    // Invisible to the narrow declaration roots — which is exactly the blind
    // spot the sweep exists to close.
    assert.deepEqual(findSuspendingToolModules(workspace), []);
    assert.deepEqual(findSuspendingToolModules(workspace, REPO_SWEEP_ROOTS), [
      'packages/some-new-package/src/tools/rogue-tool.ts',
    ]);
  });
});

test('CONTROL: a renamed declaration root is caught, not silently dropped', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(workspace, 'packages/agent/src/tools/ask-user-tool.ts', 'const s = 1;\n');
    // `apps/desktop/src/assistant-server` does not exist in this workspace, so
    // the walker's `catch { return out }` yields [] for it — the exact silent
    // drop the root assertion turns into a failure.
    assert.deepEqual(
      walkTypeScriptFiles(path.join(workspace, 'apps/desktop/src/assistant-server'), []),
      []
    );
    assert.equal(
      walkTypeScriptFiles(path.join(workspace, 'packages/agent/src/tools'), []).length,
      1
    );
  });
});

test('CONTROL: does NOT flag prose in line or block comments', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(
      workspace,
      'packages/agent/src/tools/commented.ts',
      '// would drop suspendSchema/resumeSchema and break suspension\n' +
        '/* suspendSchema lives on the tool definition */\n' +
        'export const t = createTool({});\n'
    );
    assert.deepEqual(findSuspendingToolModules(workspace), []);
  });
});

test('CONTROL: ignores test files and __tests__ directories', async () => {
  await withWorkspace(async (workspace) => {
    await writeSource(
      workspace,
      'packages/agent/src/tools/__tests__/rogue-tool.spec.ts',
      'expect(tool.suspendSchema).toBeDefined();\n'
    );
    await writeSource(
      workspace,
      'packages/agent/src/tools/rogue-tool.test.ts',
      'expect(tool.suspendSchema).toBeDefined();\n'
    );
    assert.deepEqual(findSuspendingToolModules(workspace), []);
  });
});
