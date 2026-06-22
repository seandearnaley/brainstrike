/**
 * LIVE-loop coverage for the desktop `brainstrike.globWorkspace` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * desktop glob tool from `buildDesktopAssistantTools` — its real `execute`, the
 * real FS walk + ignore policy + path containment, against a real temp-dir
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
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const USAGE = { promptTokens: 8, completionTokens: 4, totalTokens: 12 } as const;

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
    requests,
    warmup: vi.fn().mockResolvedValue(undefined),
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
          text: 'Found the files.',
          finishReason: 'stop',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-glob-1',
            type: 'function',
            function: {
              name: 'brainstrike_globWorkspace',
              arguments: JSON.stringify({ pattern }),
            },
          },
        ],
        usage: USAGE,
      });
    },
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
  return root;
}

describe('globWorkspace live Mastra loop (real agent, real tool execute)', () => {
  it('lets a real Agent enumerate matching files and excludes ignored dirs', async () => {
    const workspaceRootPath = await createWorkspaceFixture();
    try {
      const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
      const globTool = tools['brainstrike.globWorkspace'];
      expect(globTool).toBeDefined();

      const hostClient = createScriptedHostClient('**/*.test.ts');

      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-glob',
            role: 'user',
            parts: [{ type: 'text', text: 'list every test file' }],
          },
        ],
        {
          runtime: {
            provider: 'local',
            model: 'onnx-community/gemma-4-E2B-it-ONNX',
            localLlmHostClient: hostClient,
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
      await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
    }
  });
});
