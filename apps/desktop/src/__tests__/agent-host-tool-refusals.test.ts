// @vitest-environment node
/**
 * BST-1985: a native tool's deliberate refusal reaches the model verbatim as a
 * `tool_input_invalid` result, while an unexpected executor error stays the
 * redacted `tool_failed` text. Every call goes through the host's real tool
 * binding (execution guard included) over a real filesystem.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostTool, HostToolContext } from '@brainstrike/agent-host';
import { buildNativeToolRiskMap, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { ReadWorkspaceFileCursorRegistry } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, expect, test, vi } from 'vitest';
import { desktopHostSharedTools } from '../agent-host-platform/desktop-host-shared-tools';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';

const GENERIC_FAILURE = 'The tool did not complete successfully. Try another approach.';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function directory(prefix: string): Promise<string> {
  const created = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(created);
  return created;
}

interface Root {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
}

const TOOL_IDS = [
  NATIVE_TOOL_ID.deleteWorkspaceFile,
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.readWorkspaceContext,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.renameWorkspaceFile,
  NATIVE_TOOL_ID.writeWorkspaceFile,
];
/** Each tool's catalog risk, which the host binding requires its descriptor to match. */
const risks = buildNativeToolRiskMap();

function hostTools(
  roots: readonly Root[],
  request: (method: string, input: unknown) => Promise<unknown>,
  native: Record<string, unknown> = {}
): Record<string, HostTool> {
  const selected = PlatformSelectionSchema.parse({
    configuration: { model: 'gpt-6-sol', provider: 'openai' },
    contextWindow: 32_000,
    durableConfiguration: {},
    inputTokenLimit: 24_000,
    maxSteps: 3,
    memory: {
      options: {
        lastMessages: 1,
        workingMemory: { enabled: false, scope: 'thread', template: '' },
      },
      settings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 1000,
          modelTarget: 'auto',
          observationTokens: 1000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: null,
          enabled: false,
          messageRange: 0,
          scope: 'thread',
          topK: 1,
        },
      },
    },
    nativeRuntime: { provider: 'openai', workspaceRoots: roots, ...native },
    resourceId: 'workspace',
    tools: Object.fromEntries(
      TOOL_IDS.map((id) => [
        id.replace('.', '_'),
        {
          description: id,
          identity: id,
          inputSchema: { type: 'object' },
          permissionToolId: id,
          risk: risks[id],
        },
      ])
    ),
    toolTimeoutMs: 5000,
  });
  return desktopHostSharedTools({
    freshRoots: () => request('admission/fresh-roots', {}),
    readFileCursorRegistry: new ReadWorkspaceFileCursorRegistry(),
    request,
    resolveTavilyApiKey: async () => undefined,
    selected,
    threadId: 'host-thread',
  });
}

function execution(): HostToolContext {
  return {
    edits: { track: async (_edit, mutate) => await mutate() },
    runId: 'host-run',
    signal: new AbortController().signal,
    state: {
      entries: () => [],
      read: async () => undefined,
      update: async () => undefined,
    },
    threadId: 'host-thread',
    toolCallId: 'refusal-call',
  };
}

function tool(tools: Record<string, HostTool>, id: string): HostTool {
  const found = tools[id.replace('.', '_')];
  if (!found) {
    throw new Error(`${id} was not built for the host`);
  }
  return found;
}

function refusal(toolName: string, message: string) {
  return { error: { code: 'tool_input_invalid', message, toolName }, ok: false };
}

/** Main answers only the admission's root revalidation; any other request fails loudly. */
function rootsOnly(roots: readonly Root[]) {
  return vi.fn(async (method: string, _input: unknown) => {
    if (method === 'admission/fresh-roots') {
      return roots;
    }
    throw new Error(`Unexpected Main request ${method}`);
  });
}

test('the recorded out-of-scope filePaths grep returns its actionable refusal to the model', async () => {
  // Recorded in the #3567 smoke (12 Oct 2026): a thread bound to alpha-root
  // grepped absolute filePaths spanning both open folders, and the model got
  // only the generic failure while this text went to a level-50 log. A grep
  // with no root now searches every thread folder (BST-1990), so this search
  // names alpha-root.
  const parent = await directory('bs-m6-refusal-grep-');
  const alpha = join(parent, 'alpha-root');
  const bravo = join(parent, 'bravo-root');
  for (const [root, name] of [
    [alpha, 'alpha'],
    [bravo, 'bravo'],
  ] as const) {
    await mkdir(root);
    await writeFile(join(root, 'README.md'), `SMOKE_NEEDLE_3567 in the ${name} readme\n`);
    await writeFile(join(root, `stale-${name}.txt`), `SMOKE_NEEDLE_3567 stale ${name} line\n`);
  }
  const roots = [
    { displayName: 'alpha-root', path: alpha, rootId: 'root-alpha' },
    { displayName: 'bravo-root', path: bravo, rootId: 'root-bravo' },
  ];
  const request = rootsOnly(roots);
  const grep = tool(
    hostTools(roots, request, { boundWorkspaceRootId: 'root-alpha' }),
    NATIVE_TOOL_ID.grepSearch
  );

  const output = await grep.execute(
    {
      filePaths: [
        join(alpha, 'README.md'),
        join(alpha, 'stale-alpha.txt'),
        join(bravo, 'README.md'),
        join(bravo, 'stale-bravo.txt'),
      ],
      maxResults: 100,
      outputMode: 'content',
      pattern: 'SMOKE_NEEDLE_3567',
      root: 'alpha-root',
    },
    execution()
  );

  expect(output).toEqual(
    refusal(
      NATIVE_TOOL_ID.grepSearch,
      `filePaths entry "${join(bravo, 'README.md')}" is not inside the folder this search is scoped to, alpha-root (${alpha}). ` +
        'Pass a path inside an open folder, or drop filePaths to search everywhere.'
    )
  );
  // Refused before the indexed half was asked for.
  expect(request.mock.calls.map(([method]) => method)).not.toContain('desktop-read/grep-index');
});

test('an unexpected executor error still reaches the model only as the redacted generic text', async () => {
  const root = await directory('bs-m6-refusal-fault-');
  await writeFile(join(root, 'notes.txt'), 'needle on disk\n');
  const roots = [{ displayName: 'A', path: root, rootId: 'root-a' }];
  const leak = `EACCES: permission denied, open '${root}/secret.env' token=sk-live-BST1985LEAK`;
  const request = vi.fn(async (method: string, _input: unknown) => {
    if (method === 'admission/fresh-roots') {
      return roots;
    }
    throw new Error(leak);
  });
  const grep = tool(hostTools(roots, request), NATIVE_TOOL_ID.grepSearch);

  const output = await grep.execute({ outputMode: 'files', pattern: 'needle' }, execution());

  expect(output).toEqual({
    error: { code: 'tool_failed', message: GENERIC_FAILURE, toolName: NATIVE_TOOL_ID.grepSearch },
    ok: false,
  });
  const serialized = JSON.stringify(output);
  for (const secret of [root, 'secret.env', 'sk-live-BST1985LEAK']) {
    expect(serialized).not.toContain(secret);
  }
});

test('deliberate path, read, write and context refusals reach the model verbatim', async () => {
  const root = await directory('bs-m6-refusal-paths-');
  const outside = await directory('bs-m6-refusal-outside-');
  await writeFile(join(outside, 'private.txt'), 'outside the root\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'taken.ts'), 'export const taken = 1;\n');
  await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await writeFile(join(root, 'secret.txt'), 'ignored by the agent\n');
  await writeFile(join(root, '.brainstrikeignore'), 'secret.txt\n');
  await symlink(outside, join(root, 'escape'));
  // A link that leaves the root gets the containment refusal whether or not its
  // outside target exists, so a read reveals nothing about the outside.
  await symlink(join(outside, 'missing-target.txt'), join(root, 'dangling-out'));
  await symlink(join(outside, 'private.txt'), join(root, 'link-out-existing'));
  const roots = [{ displayName: 'A', path: root, rootId: 'root-a' }];
  const tools = hostTools(roots, rootsOnly(roots), { workspaceRootPath: root });
  const call = (id: string, input: Record<string, unknown>) =>
    tool(tools, id).execute(input, execution());

  const cases: Array<readonly [string, Record<string, unknown>, string]> = [
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'escape/private.txt' },
      'Path "escape/private.txt" is outside the selected workspace root.',
    ],
    // BST-1996 reverses BST-1892 for a path inside the root: a missing file is the
    // model's to correct, and the refusal echoes only the path the model sent.
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'src/missing.ts' },
      'Path "src/missing.ts" does not exist.',
    ],
    // A missing file behind a symlink that escapes the root keeps the containment refusal.
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'escape/missing.txt' },
      'Path "escape/missing.txt" is outside the selected workspace root.',
    ],
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'dangling-out' },
      'Path "dangling-out" is outside the selected workspace root.',
    ],
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'link-out-existing' },
      'Path "link-out-existing" is outside the selected workspace root.',
    ],
    [NATIVE_TOOL_ID.readWorkspaceFile, { path: 'src' }, 'Path "src" is not a file.'],
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'blob.bin' },
      'Path "blob.bin" is a binary file and cannot be read as text.',
    ],
    [
      NATIVE_TOOL_ID.readWorkspaceFile,
      { path: 'secret.txt' },
      'Path "secret.txt" is excluded by an agent ignore file (.llmignore/.brainstrikeignore) and cannot be read.',
    ],
    [
      NATIVE_TOOL_ID.writeWorkspaceFile,
      { content: 'x', path: 'escape/new.txt' },
      'Path "escape/new.txt" is outside the selected workspace root.',
    ],
    [
      NATIVE_TOOL_ID.deleteWorkspaceFile,
      { path: 'src' },
      'Path "src" is a directory. Deleting directories is not supported — use executeCommand for that.',
    ],
    [
      NATIVE_TOOL_ID.renameWorkspaceFile,
      { fromPath: 'src/a.ts', toPath: 'taken.ts' },
      'Destination "taken.ts" already exists. Delete it first or choose another path (rename does not overwrite).',
    ],
    // A context read names its files (BST-2019); an unknown folder is refused by type.
    [
      NATIVE_TOOL_ID.readWorkspaceContext,
      { filePaths: ['src/a.ts'], root: 'Nope' },
      'No folder "Nope" in the workspace. Open folders: A (id root-a).',
    ],
  ];
  const outcomes = [];
  for (const [id, input] of cases) {
    outcomes.push(await call(id, input));
  }
  expect(outcomes).toEqual(cases.map(([id, , message]) => refusal(id, message)));

  // The input schema admits this regex (it compiles); the matcher's ReDoS guard
  // refuses it, and that refusal is the model's to correct.
  expect(await call(NATIVE_TOOL_ID.grepSearch, { isRegex: true, pattern: '(a+)+b' })).toEqual(
    refusal(
      NATIVE_TOOL_ID.grepSearch,
      'Unsafe regex pattern rejected (catastrophic backtracking risk): (a+)+b'
    )
  );
});
