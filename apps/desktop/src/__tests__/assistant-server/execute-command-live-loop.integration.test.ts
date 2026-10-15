import './_windows-command-fixture';
/**
 * LIVE-loop coverage for the desktop `brainstrike.executeCommand` tool.
 *
 * Drives the REAL Mastra agent loop (`streamMastraAgent`) against the REAL
 * desktop shell tool from the agent host's live executor fold — its real `execute`,
 * which spawns the native shell and runs a fixture command, against a real temp-dir
 * workspace. Only the language model is scripted, through `modelOverride`
 * (`_scripted-chat-model.ts`) — no API key, no network.
 *
 * Also proves the REGISTRATION GATE: the tool is exposed ONLY when permission
 * enforcement is enabled (otherwise arbitrary shell execution would be available
 * unprompted by default).
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeLiveChildProcesses } from '../../assistant-server/execute-command-tool';
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
 * Scripted model: the first turn requests the shell tool; once the tool has
 * run, it streams a short confirmation.
 */
function createScriptedExecuteModel(command: string): ScriptedChatModel {
  return createScriptedChatModel((completed) =>
    completed.includes('brainstrike_executeCommand')
      ? { chunks: ['Ran ', 'the command.'], kind: 'text' }
      : {
          calls: [
            {
              input: { command },
              toolCallId: 'call-exec-1',
              toolName: 'brainstrike_executeCommand',
            },
          ],
          kind: 'tool-call',
        }
  );
}

const createdRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-exec-live-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

async function writeCommandFixture(
  root: string,
  source: string,
  windowsCommand: string
): Promise<string> {
  const fixture = path.join(root, 'live-command.cjs');
  await fsPromises.writeFile(fixture, source, 'utf8');
  return process.platform === 'win32' ? windowsCommand : `"${process.execPath}" "${fixture}"`;
}

afterEach(async () => {
  await disposeLiveChildProcesses();
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
    const tools = buildHostNativeTools(singleRootRuntime(root));
    expect(tools['brainstrike.executeCommand']).toBeDefined();
  });
});

describe('executeCommand live Mastra loop (real agent, real shell execute)', () => {
  it('lets a real Agent run `echo hello` and flows the result back', async () => {
    const root = await makeWorkspace();
    // Side-effect marker: the real shell command writes a file we can assert on.
    const marker = path.join(root, 'ran.marker');
    const tools = buildHostNativeTools(singleRootRuntime(root), {
      ids: ['brainstrike.executeCommand'],
    });
    const executeTool = requireTool(tools, 'brainstrike.executeCommand');

    const model = createScriptedExecuteModel(
      await writeCommandFixture(
        root,
        [
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(marker)}, 'hello-from-shell\\n');`,
          "process.stdout.write('done\\n');",
        ].join('\n'),
        'echo hello-from-shell>ran.marker & echo done'
      )
    );

    const iterator = await streamMastraAgent(
      [
        {
          id: 'u-exec',
          parts: [{ text: 'run echo', type: 'text' }],
          role: 'user',
        },
      ],
      {
        ...scriptedLoopOptions(model),
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

  it('streams incremental shell output through the real desktop wiring (keyed to the tool call)', async () => {
    const root = await makeWorkspace();
    const tools = buildHostNativeTools(singleRootRuntime(root), {
      ids: ['brainstrike.executeCommand'],
    });
    const executeTool = requireTool(tools, 'brainstrike.executeCommand');

    // A command that emits a distinctive marker to stdout the tool must stream
    // live (via the Mastra writer) BEFORE the final result is captured.
    const model = createScriptedExecuteModel(
      await writeCommandFixture(
        root,
        "process.stdout.write('LIVE_STREAM_MARKER\\n');",
        'echo LIVE_STREAM_MARKER'
      )
    );

    const iterator = await streamMastraAgent(
      [{ id: 'u-exec-stream', parts: [{ text: 'run it', type: 'text' }], role: 'user' }],
      {
        ...scriptedLoopOptions(model),
        tools: { 'brainstrike.executeCommand': executeTool },
      }
    );

    const shellOutputs: Array<{ chunk: string; stream: string; toolCallId: string }> = [];
    for await (const chunk of iterator) {
      if (chunk.type === 'shell-output') {
        shellOutputs.push({
          chunk: chunk.chunk,
          stream: chunk.stream,
          toolCallId: chunk.toolCallId,
        });
      }
    }

    // The live slice(s) surfaced through the FULL desktop wiring: the tool's
    // writer emitted them, keyed to the scripted tool call id 'call-exec-1'.
    expect(shellOutputs.length).toBeGreaterThanOrEqual(1);
    expect(shellOutputs.map((part) => part.chunk).join('')).toContain('LIVE_STREAM_MARKER');
    expect(shellOutputs.every((part) => part.toolCallId === 'call-exec-1')).toBe(true);
    expect(shellOutputs.every((part) => part.stream === 'stdout')).toBe(true);
  });
});
