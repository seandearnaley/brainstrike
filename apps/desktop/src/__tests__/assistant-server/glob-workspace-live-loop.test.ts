/**
 * LIVE-loop coverage for the desktop `brainstrike.globWorkspace` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * host glob tool (the agent host's live executor fold, `_host-native-tools`) —
 * its real `execute`, the real FS walk + ignore policy + path containment, against a real temp-dir
 * workspace. Only the language model is scripted (provider 'local' with an
 * injected `LocalLlmHostClient`, mirroring write-workspace-file-live-loop.test.ts
 * — no API key, no network).
 *
 * It proves a real Agent can call globWorkspace, that the right files are
 * enumerated, that ignored dirs (node_modules, .git, dist) are excluded, and
 * that the tool result flows back through the loop.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeData } from '@brainstrike/agent';
import type {
  LocalLlmGenerationResult,
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostRequestOptions,
} from '@brainstrike/agent/local-llm';
import { resetToolCallLoopGuards } from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import { requireTool, singleRootRuntime } from './_tool-test-helpers';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const USAGE = { completionTokens: 4, promptTokens: 8, totalTokens: 12 } as const;

beforeEach(() => {
  resetToolCallLoopGuards();
});

/**
 * Scripted host client: the first generation requests the glob tool; once the
 * prompt carries the tool response, it streams a short confirmation and returns
 * the final answer. Mirrors the desktop llm-host contract.
 */
function createScriptedHostClient(
  pattern: string
): LocalLlmHostClient & { requests: LocalLlmHostGenerateRequest[] } {
  const requests: LocalLlmHostGenerateRequest[] = [];
  return {
    generate: (
      request: LocalLlmHostGenerateRequest,
      options: LocalLlmHostRequestOptions = {}
    ): Promise<LocalLlmGenerationResult> => {
      requests.push(request);
      const hasToolResponse = request.messages.some(
        (message) => message.role === 'tool' && message.toolResponses !== undefined
      );
      if (hasToolResponse) {
        options.onProgress?.({ kind: 'text', text: 'Found ' });
        options.onProgress?.({ kind: 'text', text: 'Found the files.' });
        return Promise.resolve({
          finishReason: 'stop',
          text: 'Found the files.',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: JSON.stringify({ pattern }),
              name: 'brainstrike_globWorkspace',
            },
            id: 'call-glob-1',
            type: 'function',
          },
        ],
        usage: USAGE,
      });
    },
    requests,
    warmup: vi.fn().mockResolvedValue(undefined),
  };
}

function createGlobThenReadHostClient(): LocalLlmHostClient & {
  requests: LocalLlmHostGenerateRequest[];
} {
  const requests: LocalLlmHostGenerateRequest[] = [];
  return {
    generate: (
      request: LocalLlmHostGenerateRequest,
      options: LocalLlmHostRequestOptions = {}
    ): Promise<LocalLlmGenerationResult> => {
      requests.push(request);
      const completedToolNames = request.messages.flatMap(
        (message) => message.toolResponses?.map((response) => response.name) ?? []
      );
      if (!completedToolNames.includes('brainstrike_globWorkspace')) {
        return Promise.resolve({
          finishReason: 'tool_calls',
          text: '',
          toolCalls: [
            {
              function: {
                arguments: JSON.stringify({ pattern: '**/README.md' }),
                name: 'brainstrike_globWorkspace',
              },
              id: 'call-glob-readme',
              type: 'function',
            },
          ],
          usage: USAGE,
        });
      }
      if (!completedToolNames.includes('brainstrike_readWorkspaceFile')) {
        return Promise.resolve({
          finishReason: 'tool_calls',
          text: '',
          toolCalls: [
            {
              function: {
                arguments: JSON.stringify({ path: 'README.md' }),
                name: 'brainstrike_readWorkspaceFile',
              },
              id: 'call-read-readme',
              type: 'function',
            },
          ],
          usage: USAGE,
        });
      }
      options.onProgress?.({ kind: 'text', text: 'Marker: ' });
      options.onProgress?.({ kind: 'text', text: 'Marker: NORTHWIND-LIVE-LOOP' });
      return Promise.resolve({
        finishReason: 'stop',
        text: 'Marker: NORTHWIND-LIVE-LOOP',
        usage: USAGE,
      });
    },
    requests,
    warmup: vi.fn().mockResolvedValue(undefined),
  };
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

      const hostClient = createScriptedHostClient('**/*.test.ts');

      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-glob',
            parts: [{ text: 'list every test file', type: 'text' }],
            role: 'user',
          },
        ],
        {
          runtime: {
            localLlmHostClient: hostClient,
            model: 'onnx-community/gemma-4-E2B-it-ONNX',
            provider: 'local',
            providerOptions: { local: { thinking: { enabled: false } } },
          } as RuntimeData,
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
      const hostClient = createGlobThenReadHostClient();
      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-glob-read',
            parts: [{ text: 'Find and read the workspace README', type: 'text' }],
            role: 'user',
          },
        ],
        {
          runtime: {
            localLlmHostClient: hostClient,
            model: 'onnx-community/gemma-4-E2B-it-ONNX',
            provider: 'local',
            providerOptions: { local: { thinking: { enabled: false } } },
          } as RuntimeData,
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

      expect(hostClient.requests).toHaveLength(3);
      expect(completedToolCount).toBe(2);
      const completedToolNames = hostClient.requests.flatMap((request) =>
        request.messages.flatMap(
          (message) => message.toolResponses?.map((response) => response.name) ?? []
        )
      );
      expect(new Set(completedToolNames)).toEqual(
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
