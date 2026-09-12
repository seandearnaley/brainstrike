// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const resultSchema = z.object({
  childCalls: z.number(),
  effect: z.string().nullable(),
  history: z.string(),
  parentCalls: z.number(),
  pid: z.number(),
  receipt: z.object({ state: z.string(), threadId: z.string(), turnMessageId: z.string() }),
  rejected: z.boolean(),
  rootHistory: z.string(),
  rootText: z.string(),
  stoppedState: z.string(),
  usage: z.array(
    z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      root_thread_id: z.literal('root'),
      run_id: z.string(),
      thread_id: z.string(),
    })
  ),
});

it.for(['single', 'stop-sibling'] as const)(
  'continues an idle grandchild across real host processes with one authorized effect and one parent outcome (%s)',
  async (mode, { signal }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-idle-grandchild-restart-'));
    const bundle = await build({
      bundle: true,
      entryPoints: [path.join(import.meta.dirname, 'fixtures/idle-grandchild-restart.mts')],
      external: ['@brainstrike/*'],
      format: 'esm',
      packages: 'external',
      platform: 'node',
      write: false,
    });
    const fixture = bundle.outputFiles[0];
    if (!fixture) {
      throw new Error('Missing compiled native restart boundary');
    }
    const run = async (phase: string) => {
      const execution = execFileAsync(
        process.execPath,
        ['--input-type=module', '-', directory, phase, mode],
        { cwd: path.resolve(import.meta.dirname, '../../..'), signal }
      );
      const input = execution.child.stdin;
      if (!input) {
        throw new Error('Native restart fixture requires stdin');
      }
      await Promise.all([pipeline(Readable.from([fixture.text]), input), execution]);
      return resultSchema.parse(
        JSON.parse(await readFile(path.join(directory, `${phase}.json`), 'utf8'))
      );
    };
    try {
      const initial = await run('initial');
      expect(initial).toMatchObject({
        childCalls: mode === 'single' ? 1 : 2,
        effect: null,
        parentCalls: 0,
        receipt: {
          state: 'awaiting-approval',
          threadId: mode === 'single' ? 'grandchild' : 'sibling',
          turnMessageId: mode === 'single' ? 'idle-grandchild-input' : 'idle-sibling-input',
        },
      });
      const resumed = await run('resume');
      expect(resumed.pid).not.toBe(initial.pid);
      expect(resumed).toMatchObject({
        childCalls: 1,
        effect: 'effect-once',
        parentCalls: 1,
        receipt: { state: 'completed', threadId: mode === 'single' ? 'grandchild' : 'sibling' },
        rootText: 'PARENT_ACKNOWLEDGES_GRANDCHILD',
        stoppedState: mode === 'single' ? 'completed' : 'cancelled',
      });
      expect(resumed.history).toContain('SAVED_GRANDCHILD_CONTEXT');
      expect(resumed.history).toContain('GRANDCHILD_FINISHED_ONCE');
      expect(resumed.rootHistory).toContain('PARENT_ACKNOWLEDGES_GRANDCHILD');
      expect(resumed.usage).toEqual([
        {
          input_tokens: 1,
          output_tokens: 1,
          root_thread_id: 'root',
          run_id: 'initial',
          thread_id: 'grandchild',
        },
        ...(mode === 'stop-sibling'
          ? [
              {
                input_tokens: 1,
                output_tokens: 1,
                root_thread_id: 'root',
                run_id: 'initial-sibling',
                thread_id: 'sibling',
              },
            ]
          : []),
        {
          input_tokens: 1,
          output_tokens: 1,
          root_thread_id: 'root',
          run_id: 'resume',
          thread_id: mode === 'single' ? 'grandchild' : 'sibling',
        },
      ]);
      const recovered = await run('recover');
      expect(new Set([initial.pid, resumed.pid, recovered.pid]).size).toBe(3);
      expect(recovered).toMatchObject({
        childCalls: 0,
        effect: 'effect-once',
        parentCalls: 0,
        receipt: { state: 'completed' },
        rejected: true,
      });
      expect(recovered.usage).toEqual(resumed.usage);
      expect(recovered.rootHistory).toBe(resumed.rootHistory);
      expect(recovered.history).toBe(resumed.history);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);
