/**
 * LIVE-loop coverage for the desktop `brainstrike.writeWorkspaceFile` tool.
 *
 * This drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * host write tool (the agent host's live executor fold, `_host-native-tools`) — its real `execute`,
 * real path containment, and a real temp-dir workspace. Only two seams are
 * scripted: the language model (through `modelOverride`, see
 * `_scripted-chat-model.ts` — no API key, no network) and the Electron/db
 * surfaces the desktop test setup already stubs.
 *
 * It proves a real Agent can call writeWorkspaceFile, a real file lands on disk
 * with the right bytes, and the tool result flows back through the loop. The
 * global desktop setup mocks `streamMastraAgent`; this file restores the REAL
 * implementation so the assertion exercises the actual tool-execution path.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildHostNativeTools } from './_host-native-tools';
import {
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

/**
 * Scripted model: the first turn requests the write tool; once the tool has
 * run, it streams a short confirmation.
 */
function createScriptedWriteModel(args: { path: string; content: string }): ScriptedChatModel {
  return createScriptedChatModel((completed) =>
    completed.includes('brainstrike_writeWorkspaceFile')
      ? { chunks: ['Wrote ', 'the file.'], kind: 'text' }
      : {
          calls: [
            {
              input: { content: args.content, path: args.path },
              toolCallId: 'call-write-1',
              toolName: 'brainstrike_writeWorkspaceFile',
            },
          ],
          kind: 'tool-call',
        }
  );
}

describe('writeWorkspaceFile live Mastra loop (real agent, real tool execute)', () => {
  it('lets a real Agent write a real file via the desktop tool and returns the result', async () => {
    const workspaceRootPath = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-wwf-live-')
    );
    const targetPath = '/src/generated/output.ts';
    const targetContent = 'export const generated = 42;\n';

    try {
      const tools = buildHostNativeTools(singleRootRuntime(workspaceRootPath));
      const writeTool = requireTool(tools, 'brainstrike.writeWorkspaceFile');

      const model = createScriptedWriteModel({
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
          ...scriptedLoopOptions(model),
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
