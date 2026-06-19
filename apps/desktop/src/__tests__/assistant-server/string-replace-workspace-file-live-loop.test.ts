/**
 * LIVE-loop coverage for the desktop `brainstrike.stringReplaceWorkspaceFile`
 * tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * desktop string-replace tool from `buildDesktopAssistantTools` — its real
 * `execute`, the real fuzzy-match cascade, real path containment, and a real
 * temp-dir workspace. Only the language model is scripted (provider 'local' with
 * an injected `LocalLlmHostClient`, mirroring write-workspace-file-live-loop.test.ts
 * — no API key, no network).
 *
 * Proves a real Agent can call stringReplace, the matched block on a REAL file is
 * surgically replaced while the rest of the file is left intact, and the tool
 * result flows back through the loop. The global desktop setup mocks
 * `streamMastraAgent`; this file restores the REAL implementation.
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

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const USAGE = { promptTokens: 8, completionTokens: 4, totalTokens: 12 } as const;

function createScriptedHostClient(args: {
  path: string;
  oldStr: string;
  newStr: string;
}): LocalLlmHostClient & { requests: LocalLlmHostGenerateRequest[] } {
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
        options.onProgress?.({ kind: 'text', text: 'Edited ' });
        options.onProgress?.({ kind: 'text', text: 'Edited the file.' });
        return Promise.resolve({
          text: 'Edited the file.',
          finishReason: 'stop',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call-sr-1',
            type: 'function',
            function: {
              name: 'brainstrike_stringReplaceWorkspaceFile',
              arguments: JSON.stringify({
                path: args.path,
                oldStr: args.oldStr,
                newStr: args.newStr,
              }),
            },
          },
        ],
        usage: USAGE,
      });
    },
  };
}

describe('stringReplaceWorkspaceFile live Mastra loop (real agent, real tool execute)', () => {
  it('lets a real Agent surgically edit a real file and leaves the rest intact', async () => {
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-sr-live-')
    );
    const targetPath = '/src/config.ts';
    const original = [
      'export const config = {',
      '  retries: 3,',
      '  timeoutMs: 1000,',
      '};\n',
    ].join('\n');
    const expected = [
      'export const config = {',
      '  retries: 5,',
      '  timeoutMs: 1000,',
      '};\n',
    ].join('\n');

    await fsPromises.mkdir(path.join(workspaceRootPath, 'src'), { recursive: true });
    await fsPromises.writeFile(path.join(workspaceRootPath, 'src', 'config.ts'), original, 'utf8');

    try {
      const tools = buildDesktopAssistantTools({ workspaceRootPath } as RuntimeData);
      const editTool = tools['brainstrike.stringReplaceWorkspaceFile'];
      expect(editTool).toBeDefined();

      const hostClient = createScriptedHostClient({
        path: targetPath,
        oldStr: '  retries: 3,',
        newStr: '  retries: 5,',
      });

      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-edit',
            role: 'user',
            parts: [{ type: 'text', text: 'bump retries to 5 in the config' }],
          },
        ],
        {
          runtime: {
            provider: 'local',
            model: 'onnx-community/gemma-4-E2B-it-ONNX',
            localLlmHostClient: hostClient,
            providerOptions: { local: { thinking: { enabled: false } } },
          } as RuntimeData,
          tools: { 'brainstrike.stringReplaceWorkspaceFile': editTool },
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

      expect(runEventKinds).toContain('tool.completed');
      expect(finalText).toContain('Edited the file.');

      // The REAL file was surgically edited: only the matched line changed.
      const onDisk = await fsPromises.readFile(
        path.join(workspaceRootPath, 'src', 'config.ts'),
        'utf8'
      );
      expect(onDisk).toBe(expected);

      // The tool's success result is visible to the loop.
      const serialized = JSON.stringify(toolEventResults);
      expect(serialized).toContain('/src/config.ts');
      expect(serialized).toContain('"replaced":true');
    } finally {
      await fsPromises.rm(workspaceRootPath, { recursive: true, force: true });
    }
  });
});
