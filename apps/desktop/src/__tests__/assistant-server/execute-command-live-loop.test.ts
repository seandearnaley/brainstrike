/**
 * LIVE-loop coverage for the desktop `brainstrike.executeCommand` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * desktop shell tool from `buildDesktopAssistantTools` — its real `execute`,
 * which spawns `/bin/sh` and runs `echo hello`, against a real temp-dir
 * workspace. Only the language model is scripted (provider 'local' with an
 * injected `LocalLlmHostClient`, mirroring glob-workspace-live-loop.test.ts —
 * no API key, no network).
 *
 * Also proves the REGISTRATION GATE: the tool is exposed ONLY when permission
 * enforcement is enabled (otherwise arbitrary shell execution would be available
 * unprompted by default).
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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { disposeLiveChildProcesses } from '../../assistant-server/execute-command-tool';

// Restore the REAL streamMastraAgent (the global setup.ts mock replaces it with
// an empty generator). Everything else from the package keeps its real impl.
vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const USAGE = { completionTokens: 4, promptTokens: 8, totalTokens: 12 } as const;

/**
 * Scripted host client: the first generation requests the shell tool; once the
 * prompt carries the tool response, it streams a short confirmation and returns
 * the final answer. Mirrors the desktop llm-host contract.
 */
function createScriptedHostClient(command: string): LocalLlmHostClient {
  return {
    generate: (
      request: LocalLlmHostGenerateRequest,
      options: LocalLlmHostRequestOptions = {}
    ): Promise<LocalLlmGenerationResult> => {
      const hasToolResponse = request.messages.some(
        (message) => message.role === 'tool' && message.toolResponses !== undefined
      );
      if (hasToolResponse) {
        options.onProgress?.({ kind: 'text', text: 'Ran ' });
        options.onProgress?.({ kind: 'text', text: 'Ran the command.' });
        return Promise.resolve({
          finishReason: 'stop',
          text: 'Ran the command.',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: JSON.stringify({ command }),
              name: 'brainstrike_executeCommand',
            },
            id: 'call-exec-1',
            type: 'function',
          },
        ],
        usage: USAGE,
      });
    },
    warmup: vi.fn().mockResolvedValue(undefined),
  };
}

const createdRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-exec-live-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

afterEach(async () => {
  disposeLiveChildProcesses();
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
});

describe('executeCommand registration', () => {
  // The interim "register only when enforcement is on" gate was removed: the tool
  // is now ALWAYS registered like every other native tool, and the permission
  // engine (enforce-on-by-default → execute:ask) suspends the run for per-call
  // approval before it executes.
  it('is ALWAYS present in the tool map (gated by the permission engine, not registration)', async () => {
    const root = await makeWorkspace();
    const tools = buildDesktopAssistantTools({ workspaceRootPath: root } as RuntimeData);
    expect(tools['brainstrike.executeCommand']).toBeDefined();
  });
});

describe('executeCommand live Mastra loop (real agent, real shell execute)', () => {
  it('lets a real Agent run `echo hello` and flows the result back', async () => {
    const root = await makeWorkspace();
    // Side-effect marker: the real shell command writes a file we can assert on.
    const marker = path.join(root, 'ran.marker');
    const tools = buildDesktopAssistantTools({ workspaceRootPath: root } as RuntimeData);
    const executeTool = tools['brainstrike.executeCommand'];
    expect(executeTool).toBeDefined();

    const hostClient = createScriptedHostClient(`echo hello-from-shell > "${marker}"; echo done`);

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-exec',
          parts: [{ text: 'run echo', type: 'text' }],
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
        tools: { 'brainstrike.executeCommand': executeTool },
      }
    );

    const runEventKinds: string[] = [];
    let finalText = '';
    const toolEvents: unknown[] = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'run-event') {
        runEventKinds.push(chunk.event.kind);
      } else if (chunk.type === 'text-delta') {
        finalText += chunk.value;
      } else if (chunk.type === 'tool-event') {
        toolEvents.push(chunk);
      }
    }

    // The real Mastra loop ran the shell tool to completion and streamed the answer.
    expect(runEventKinds).toContain('tool.completed');
    expect(finalText).toContain('Ran the command.');

    // The tool result carried the real subprocess output (exitCode 0 + stdout).
    const serialized = JSON.stringify(toolEvents);
    expect(serialized).toContain('done');

    // Side-effect proof: the real subprocess actually wrote the marker on disk.
    const markerContent = await fsPromises.readFile(marker, 'utf8');
    expect(markerContent).toContain('hello-from-shell');
  });
});
