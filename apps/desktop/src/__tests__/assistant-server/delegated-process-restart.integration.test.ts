// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const resultSchema = z.object({
  decisions: z.array(z.object({ state: z.string() })),
  effects: z.number().int(),
  pid: z.number().int(),
  rejected: z.boolean(),
  toolResults: z.array(z.object({ output: z.unknown(), toolName: z.string() })),
});

let fixtureCode: string;
beforeAll(async () => {
  // Compile the complete local-source closure, as the Electron main bundle does.
  // Package imports remain external and resolve from the desktop workspace.
  const output = await build({
    bundle: true,
    entryPoints: [path.join(import.meta.dirname, 'fixtures/delegated-process-restart.mts')],
    external: ['@brainstrike/*'],
    format: 'esm',
    packages: 'external',
    platform: 'node',
    write: false,
  });
  const file = output.outputFiles[0];
  if (!file) {
    throw new Error('Restart fixture build emitted no JavaScript');
  }
  fixtureCode = file.text;
});

it.for(['approve', 'decline', 'interrupt', 'answer', 'plan-approve', 'plan-reject'] as const)(
  'retains native grandchild decisions across fresh processes (%s)',
  async (decision, { signal }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-delegated-restart-'));
    const run = async (phase: string) => {
      await execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          fixtureCode,
          'delegated-process-restart',
          directory,
          phase,
          decision,
        ],
        {
          cwd: path.resolve(import.meta.dirname, '../../..'),
          signal,
        }
      );
      return resultSchema.parse(
        JSON.parse(await readFile(path.join(directory, `${phase}.json`), 'utf8'))
      );
    };
    try {
      const initial = await run('initial');
      expect(initial.effects).toBe(0);
      expect(initial.decisions).toEqual([]);
      expect(initial.toolResults).toEqual([]);
      const resumed = await run('resume');
      expect(resumed.pid).not.toBe(initial.pid);
      expect(resumed.effects).toBe(decision === 'approve' ? 1 : 0);
      expect(resumed.decisions).toEqual([
        { state: decision === 'interrupt' ? 'claimed' : 'consumed' },
      ]);
      if (decision === 'answer' || decision.startsWith('plan-')) {
        expect(resumed.toolResults).toEqual([
          {
            output: {
              type: 'json',
              value:
                decision === 'answer'
                  ? { answer: 'App, Docs' }
                  : {
                      feedback: 'Keep the original scope.',
                      status: decision === 'plan-approve' ? 'approved' : 'rejected',
                    },
            },
            toolName: decision === 'answer' ? 'brainstrike_askUser' : 'brainstrike_submitPlan',
          },
        ]);
      }
      const recovered = await run('recover');
      expect(new Set([initial.pid, resumed.pid, recovered.pid]).size).toBe(3);
      expect(recovered.rejected).toBe(true);
      expect(recovered.toolResults).toEqual([]);
      expect(recovered.effects).toBe(decision === 'approve' ? 1 : 0);
      expect(recovered.decisions).toEqual([
        { state: decision === 'interrupt' ? 'interrupted' : 'consumed' },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);
