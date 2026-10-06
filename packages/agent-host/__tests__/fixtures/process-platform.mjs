import { spawn } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { z } from 'zod';

/** @param {import('@brainstrike/host-lease').HostStartOptions} options
 * @returns {Promise<import('../../src/ports.js').HostPlatform>} */
export async function createHostPlatform(options) {
  const root = options.root;
  await appendFile(join(root, 'fixture-platform-pids'), `${process.pid}\n`);
  await writeFile(
    join(root, 'fixture-platform-runtime'),
    JSON.stringify({
      electron: process.versions.electron ?? null,
      execPath: process.execPath,
      node: process.versions.node,
      pid: process.pid,
    })
  );
  if (process.env.BRAINSTRIKE_M3_TEST_TOOL === 'fail') {
    throw new Error('Recorded platform startup failure');
  }
  const childTool = process.env.BRAINSTRIKE_M3_TEST_TOOL === 'child';
  const toolId = childTool ? 'run_child' : 'write_file';
  return {
    async close() {
      await appendFile(join(root, 'fixture-platform-closed'), `${process.pid}\n`);
    },
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    async resolveModel(modelId) {
      if (modelId !== 'scripted') {
        throw new Error('Unknown fixture model');
      }
      return scriptedModel(toolId);
    },
    tools: {
      [toolId]: {
        description: childTool ? 'Run an owned native child' : 'Write an owned file',
        async execute(input, context) {
          const { text } = z.object({ text: z.string() }).parse(input);
          if (!childTool) {
            await appendFile(join(root, 'fixture-effect-count'), '1\n');
            await writeFile(join(root, 'permitted.txt'), text);
            return { path: join(root, 'permitted.txt') };
          }
          context.signal.throwIfAborted();
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore',
          });
          const exited = new Promise((done, reject) => {
            child.once('error', reject);
            child.once('close', done);
          });
          const abort = () => child.kill('SIGTERM');
          context.signal.addEventListener('abort', abort, { once: true });
          try {
            if (context.signal.aborted) {
              abort();
            }
            await writeFile(join(root, 'fixture-child-pid'), String(child.pid));
            await exited;
            context.signal.throwIfAborted();
            return { pid: child.pid };
          } finally {
            context.signal.removeEventListener('abort', abort);
          }
        },
        identity: 'recorded-process-fixture-generation-1',
        inputSchema: z.object({ text: z.string() }),
        risk: childTool ? 'execute' : 'edit',
      },
    },
  };
}
