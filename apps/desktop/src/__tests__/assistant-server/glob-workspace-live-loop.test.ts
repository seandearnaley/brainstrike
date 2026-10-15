/**
 * LIVE-loop coverage for the desktop `brainstrike.globWorkspace` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * host glob tool (the agent host's live executor fold, `_host-native-tools`) —
 * its real `execute`, the real FS walk + ignore policy + path containment, against a real temp-dir
 * workspace. Only the language model is scripted, through `modelOverride`
 * (`_scripted-chat-model.ts`) — no API key, no network.
 *
 * It proves a real Agent can call globWorkspace, that the right files are
 * enumerated, that ignored dirs (node_modules, .git, dist) are excluded, and
 * that the tool result flows back through the loop.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import {
  completedToolNames,
  createScriptedChatModel,
  type ScriptedChatModel,
  scriptedLoopOptions,
} from './_scripted-chat-model';
import { requireTool, singleRootRuntime } from './_tool-test-helpers';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

beforeEach(() => {
  resetToolCallLoopGuards();
});

/**
 * Scripted model: the first turn requests the glob tool; once the prompt
 * carries the tool result, it streams a short confirmation.
 */
function createScriptedGlobModel(pattern: string): ScriptedChatModel {
  return createScriptedChatModel((completed) =>
    completed.includes('brainstrike_globWorkspace')
      ? { chunks: ['Found ', 'the files.'], kind: 'text' }
      : {
          calls: [
            {
              input: { pattern },
              toolCallId: 'call-glob-1',
              toolName: 'brainstrike_globWorkspace',
            },
          ],
          kind: 'tool-call',
        }
  );
}

function createGlobThenReadModel(): ScriptedChatModel {
  return createScriptedChatModel((completed) => {
    if (!completed.includes('brainstrike_globWorkspace')) {
      return {
        calls: [
          {
            input: { pattern: '**/README.md' },
            toolCallId: 'call-glob-readme',
            toolName: 'brainstrike_globWorkspace',
          },
        ],
        kind: 'tool-call',
      };
    }
    if (!completed.includes('brainstrike_readWorkspaceFile')) {
      return {
        calls: [
          {
            input: { path: 'README.md' },
            toolCallId: 'call-read-readme',
            toolName: 'brainstrike_readWorkspaceFile',
          },
        ],
        kind: 'tool-call',
      };
    }
    return { chunks: ['Marker: ', 'NORTHWIND-LIVE-LOOP'], kind: 'text' };
  });
}

async function createWorkspaceFixture(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-glob-live-'));
  await fsPromises.mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await fsPromises.mkdir(path.join(root, 'src', '__tests__'), { recursive: true });
  await fsPromises.mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  await fsPromises.mkdir(path.join(root, 'dist'), { recursive: true });
  await fsPromises.mkdir(path.join(root, '.git'), { recursive: true });

  await fsPromises.writeFile(path.join(root, 'src', 'main.ts'), 'export const a = 1;\n', 'utf8');
  await fsPromises.writeFile(
    path.join(root, 'src', 'components', 'button.tsx'),
    'export const Button = () => null;\n',
    'utf8'
  );
  await fsPromises.writeFile(
    path.join(root, 'src', '__tests__', 'main.test.ts'),
    'test("a", () => {});\n',
    'utf8'
  );
  await fsPromises.writeFile(
    path.join(root, 'src', 'components', 'button.test.ts'),
    'test("b", () => {});\n',
    'utf8'
  );
  // Excluded by the ignore policy: node_modules, dist build output, .git.
  await fsPromises.writeFile(
    path.join(root, 'node_modules', 'left-pad', 'index.test.ts'),
    'test("dep", () => {});\n',
    'utf8'
  );
  await fsPromises.writeFile(path.join(root, 'dist', 'bundle.test.ts'), 'noop\n', 'utf8');
  await fsPromises.writeFile(path.join(root, '.git', 'config.test.ts'), 'noop\n', 'utf8');
  await fsPromises.writeFile(path.join(root, 'README.md'), '# NORTHWIND-LIVE-LOOP\n', 'utf8');
  return root;
}

describe('globWorkspace live Mastra loop (real agent, real tool execute)', () => {
  it('lets a real Agent enumerate matching files and excludes ignored dirs', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
      const globTool = requireTool(tools, 'brainstrike.globWorkspace');

      const model = createScriptedGlobModel('**/*.test.ts');

      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-glob',
            parts: [{ text: 'list every test file', type: 'text' }],
            role: 'user',
          },
        ],
        {
          ...scriptedLoopOptions(model),
          tools: { 'brainstrike.globWorkspace': globTool },
        }
      );

      const runEventKinds: string[] = [];
      let finalText = '';
      const toolEventResults: unknown[] = [];
      for await (const chunk of iterator) {
        if (chunk.type === 'run-event') {
          runEventKinds.push(chunk.event.kind);
        } else if (chunk.type === 'text-delta') {
          finalText += chunk.value;
        } else if (chunk.type === 'tool-event') {
          toolEventResults.push(chunk);
        }
      }

      // The real Mastra loop ran the tool to completion and streamed the answer.
      expect(runEventKinds).toContain('tool.completed');
      expect(finalText).toContain('Found the files.');

      // The two in-source test files are returned; the ignored-dir copies are not.
      const serialized = JSON.stringify(toolEventResults);
      expect(serialized).toContain('/src/__tests__/main.test.ts');
      expect(serialized).toContain('/src/components/button.test.ts');
      expect(serialized).not.toContain('node_modules');
      expect(serialized).not.toContain('/dist/bundle.test.ts');
      expect(serialized).not.toContain('/.git/');
      // Non-matching source (main.ts, button.tsx) is excluded by the pattern.
      expect(serialized).not.toContain('/src/main.ts');
      expect(serialized).not.toContain('button.tsx');
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('executes one structured glob then one structured README read before answering', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
      const globTool = requireTool(tools, 'brainstrike.globWorkspace');
      const readTool = requireTool(tools, 'brainstrike.readWorkspaceFile');
      const model = createGlobThenReadModel();
      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-glob-read',
            parts: [{ text: 'Find and read the workspace README', type: 'text' }],
            role: 'user',
          },
        ],
        {
          ...scriptedLoopOptions(model),
          tools: {
            'brainstrike.globWorkspace': globTool,
            'brainstrike.readWorkspaceFile': readTool,
          },
        }
      );

      let completedToolCount = 0;
      let finalText = '';
      const toolEvents: unknown[] = [];
      for await (const chunk of iterator) {
        if (chunk.type === 'run-event' && chunk.event.kind === 'tool.completed') {
          completedToolCount += 1;
        } else if (chunk.type === 'text-delta') {
          finalText += chunk.value;
        } else if (chunk.type === 'tool-event') {
          toolEvents.push(chunk);
        }
      }

      expect(model.prompts).toHaveLength(3);
      expect(completedToolCount).toBe(2);
      expect(new Set(model.prompts.flatMap((prompt) => completedToolNames(prompt)))).toEqual(
        new Set(['brainstrike_globWorkspace', 'brainstrike_readWorkspaceFile'])
      );
      expect(JSON.stringify(toolEvents)).toContain('NORTHWIND-LIVE-LOOP');
      expect(finalText).toBe('Marker: NORTHWIND-LIVE-LOOP');
      expect(finalText).not.toMatch(/<\||<tool_|<channel\|>/);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });
});
