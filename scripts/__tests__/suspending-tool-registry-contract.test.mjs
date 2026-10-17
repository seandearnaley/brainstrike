import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * HostCore owns interaction and consent. Producer-side vendor suspensions are
 * forbidden: this recursive cross-root scan rejects a new suspendSchema even
 * when declared in a new package. Negative controls below keep the scan honest.
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

/** No host producer may reintroduce vendor suspension ownership (ADR-0023). */
const REGISTERED_SUSPENDING_TOOL_MODULES = [];
const ACKNOWLEDGED_NON_DECLARING_MODULES = [];

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

test('host producers have no vendor suspendSchema', () => {
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
