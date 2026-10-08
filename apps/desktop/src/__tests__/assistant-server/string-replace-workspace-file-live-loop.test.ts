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
import {
  EDIT_FAILURE_HINT_MESSAGE,
  resetToolCallLoopGuards,
} from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDesktopAssistantTools } from '../../assistant-server/assistant-tools';
import { requireTool, requireToolExecute, singleRootRuntime } from './_tool-test-helpers';

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return { ...actual };
});

const { streamMastraAgent } = await import('@brainstrike/agent');

const USAGE = { completionTokens: 4, promptTokens: 8, totalTokens: 12 } as const;

beforeEach(() => {
  resetToolCallLoopGuards();
});

function createScriptedHostClient(args: {
  path: string;
  oldStr: string;
  newStr: string;
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
        options.onProgress?.({ kind: 'text', text: 'Edited ' });
        options.onProgress?.({ kind: 'text', text: 'Edited the file.' });
        return Promise.resolve({
          finishReason: 'stop',
          text: 'Edited the file.',
          usage: USAGE,
        });
      }
      return Promise.resolve({
        finishReason: 'tool_calls',
        text: '',
        toolCalls: [
          {
            function: {
              arguments: JSON.stringify({
                newStr: args.newStr,
                oldStr: args.oldStr,
                path: args.path,
              }),
              name: 'brainstrike_stringReplaceWorkspaceFile',
            },
            id: 'call-sr-1',
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
      const tools = buildDesktopAssistantTools(singleRootRuntime(workspaceRootPath));
      const editTool = requireTool(tools, 'brainstrike.stringReplaceWorkspaceFile');

      const hostClient = createScriptedHostClient({
        newStr: '  retries: 5,',
        oldStr: '  retries: 3,',
        path: targetPath,
      });

      const iterator = await streamMastraAgent(
        [
          {
            id: 'u-edit',
            parts: [{ text: 'bump retries to 5 in the config', type: 'text' }],
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
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('escalates the third same-path match failure and resets after success', async () => {
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-sr-guard-')
    );
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'config.txt'),
      'enabled=true\n',
      'utf8'
    );

    try {
      const tools = buildDesktopAssistantTools({
        ...singleRootRuntime(workspaceRootPath),
        memory: { resourceId: 'edit-failure-resource', threadId: 'edit-failure-thread' },
      } as RuntimeData);
      const executeTool = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');
      const missingInput = {
        context: {
          newStr: 'missing=true',
          oldStr: 'missing=false',
          path: '/config.txt',
        },
      };

      await expect(executeTool(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining('Repeated string replacement failures'),
        reason: 'not_found',
      });
      await expect(executeTool(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining('Repeated string replacement failures'),
        reason: 'not_found',
      });
      await expect(
        executeTool({
          context: {
            newStr: 'enabled=true',
            oldStr: 'enabled=true',
            path: '/config.txt',
          },
        })
      ).rejects.toMatchObject({ reason: 'no_op' });
      // The escalated message APPENDS the hint rather than replacing the
      // fuzzy matcher's own diagnostic (PR #2323 review) — the model must
      // still see the specific "no match" detail alongside the recovery
      // guidance, not lose it at the exact moment it has the least ability
      // to guess why oldStr keeps failing.
      let escalatedError: unknown;
      try {
        await executeTool(missingInput);
        throw new Error('expected the third failure to reject');
      } catch (error) {
        escalatedError = error;
      }
      expect(escalatedError).toMatchObject({ reason: 'not_found' });
      expect((escalatedError as Error).message).toContain('No sufficiently close match');
      expect((escalatedError as Error).message).toContain(EDIT_FAILURE_HINT_MESSAGE);

      await executeTool({
        context: {
          newStr: 'enabled=false',
          oldStr: 'enabled=true',
          path: '/config.txt',
        },
      });
      await expect(executeTool(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining('Repeated string replacement failures'),
        reason: 'not_found',
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });

  it('resets the failure streak after a successful writeWorkspaceFile to the same path', async () => {
    // Regression for PR #2323 review (claude): a full rewrite via
    // writeWorkspaceFile is the very recovery the escalated hint recommends
    // ("use writeWorkspaceFile when the intended change requires a full
    // rewrite") — it must clear stringReplace's failure streak on that path
    // too, or the NEXT unrelated miss still gets the escalated message even
    // though the model just took the suggested action.
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-sr-write-reset-')
    );
    await fsPromises.writeFile(
      path.join(workspaceRootPath, 'config.txt'),
      'enabled=true\n',
      'utf8'
    );

    try {
      const tools = buildDesktopAssistantTools({
        ...singleRootRuntime(workspaceRootPath),
        memory: {
          resourceId: 'edit-failure-write-resource',
          threadId: 'edit-failure-write-thread',
        },
      } as RuntimeData);
      const executeReplace = requireToolExecute(tools, 'brainstrike.stringReplaceWorkspaceFile');
      const executeWrite = requireToolExecute(tools, 'brainstrike.writeWorkspaceFile');
      const missingInput = {
        context: {
          newStr: 'missing=true',
          oldStr: 'missing=false',
          path: '/config.txt',
        },
      };

      await expect(executeReplace(missingInput)).rejects.toMatchObject({ reason: 'not_found' });
      await expect(executeReplace(missingInput)).rejects.toMatchObject({ reason: 'not_found' });

      await executeWrite({
        context: { content: 'enabled=false\nother=1\n', path: '/config.txt' },
      });

      await expect(executeReplace(missingInput)).rejects.toMatchObject({
        message: expect.not.stringContaining(EDIT_FAILURE_HINT_MESSAGE),
        reason: 'not_found',
      });
    } finally {
      await fsPromises.rm(workspaceRootPath, { force: true, recursive: true });
    }
  });
});
