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
 *
 * Lives here rather than in a package test because it reads across packages —
 * a package-scoped vitest reading a foreign package's source is an unhashed
 * turbo input (stale-green cache landmine). `pnpm test:scripts` is uncached.
 */

const SUSPENDING_TOOL_SOURCE_ROOTS = [
  'packages/agent/src/tools',
  'apps/desktop/src/assistant-server',
];

/** The only modules allowed to declare a `suspendSchema`, repo-relative. */
const REGISTERED_SUSPENDING_TOOL_MODULES = [
  'packages/agent/src/tools/ask-user-tool.ts',
  'packages/agent/src/tools/submit-plan-tool.ts',
];

const SUSPEND_SCHEMA_TOKEN = /\bsuspendSchema\b/;

/** Remove block and line comments so prose never reads as a declaration. */
function stripComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/\/\/[^\n]*/g, ' ');
}

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
      if (entry.name === '__tests__' || entry.name === 'node_modules') {
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

test('every suspendSchema-declaring module in the repo has a registered resume UI', () => {
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
