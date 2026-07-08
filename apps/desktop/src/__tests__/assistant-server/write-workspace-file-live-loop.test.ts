/**
 * LIVE-loop coverage for the desktop `brainstrike.writeWorkspaceFile` tool.
 *
 * This drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * desktop write tool from `buildDesktopAssistantTools` — its real `execute`,
 * real path containment, and a real temp-dir workspace. Only two seams are
 * scripted: the language model (provider 'local' with an injected
 * `LocalLlmHostClient`, mirroring `mastra-local-host-execution.spec.ts` — no API
 * key, no network) and the Electron/db surfaces the desktop test setup already
 * stubs.
 *
 * It proves a real Agent can call writeWorkspaceFile, a real file lands on disk
 * with the right bytes, and the tool result flows back through the loop. The
 * global desktop setup mocks `streamMastraAgent`; this file restores the REAL
 * implementation so the assertion exercises the actual tool-execution path.
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

const USAGE = { completionTokens: 4, promptTokens: 8, totalTokens: 12 } as const;

/**
 * Scripted host client: the first generation requests the write tool; once the
 * prompt carries the tool response, it streams a short confirmation and returns
 * the final answer. Mirrors the desktop llm-host contract.
 */
function createScriptedHostClient(args: {
  path: string;
  content: string;
}): LocalLlmHostClient & { requests: LocalLlmHostGenerateRequest[] } {
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
        options.onProgress?.({ kind: 'text', text: 'Wrote ' });
        options.onProgress?.({ kind: 'text', text: 'Wrote the file.' });
        return Promise.resolve({
          finishReason: 'stop',
          text: 'Wrote the file.',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: JSON.stringify({ content: args.content, path: args.path }),
              name: 'brainstrike_writeWorkspaceFile',
            },
            id: 'call-write-1',
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

describe('writeWorkspaceFile live Mastra loop (real agent, real tool execute)', () => {
  it('lets a real Agent write a real file via the desktop tool and returns the result', async () => {
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-wwf-live-')
    );
    const targetPath = '/src/generated/output.ts';
    const targetContent = 'export const generated = 42;\n';

    try {
      const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
      const writeTool = tools['brainstrike.writeWorkspaceFile'];
      expect(writeTool).toBeDefined();

      const hostClient = createScriptedHostClient({
        content: targetContent,
        path: targetPath,
      });

      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-write',
            parts: [{ text: 'create the generated output file', type: 'text' }],
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
          // The REAL desktop write tool, sanitized name matches the model call.
          tools: { 'brainstrike.writeWorkspaceFile': writeTool },
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

      // The real Mastra loop ran the tool to completion...
      expect(runEventKinds).toContain('tool.completed');
      // ...and the model's final answer flowed back through the loop.
      expect(finalText).toContain('Wrote the file.');

      // The REAL file was written to the temp workspace with the right content.
      const onDisk = await fsPromises.readFile(
        path.join(workspaceRootPath, 'src', 'generated', 'output.ts'),
        'utf8'
      );
      expect(onDisk).toBe(targetContent);

      // The tool's success result (path/created/bytesWritten) is visible to the loop.
      const serialized = JSON.stringify(toolEventResults);
      expect(serialized).toContain('/src/generated/output.ts');
      expect(serialized).toContain('"created":true');
      expect(serialized).toContain(`"bytesWritten":${Buffer.byteLength(targetContent)}`);
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });
});
