// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const resultSchema = z.object({
  decisions: z.array(z.object({ state: z.string() })),
  effects: z.number().int(),
  pid: z.number().int(),
  rejected: z.boolean(),
});

it.for(['approve', 'decline', 'interrupt'] as const)(
  'retains native grandchild decisions across fresh processes (%s)',
  async (decision, { signal }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-delegated-restart-'));
    const fixture = path.join(import.meta.dirname, 'fixtures/delegated-process-restart.mts');
    const run = async (phase: string) => {
      await execFileAsync(process.execPath, [fixture, directory, phase, decision], {
        signal,
      });
      return resultSchema.parse(
        JSON.parse(await readFile(path.join(directory, `${phase}.json`), 'utf8'))
      );
    };
    try {
      const initial = await run('initial');
      expect(initial.effects).toBe(0);
      expect(initial.decisions).toEqual([]);
      const resumed = await run('resume');
      expect(resumed.pid).not.toBe(initial.pid);
      expect(resumed.effects).toBe(decision === 'approve' ? 1 : 0);
      expect(resumed.decisions).toEqual([
        { state: decision === 'interrupt' ? 'claimed' : 'consumed' },
      ]);
      const recovered = await run('recover');
      expect(new Set([initial.pid, resumed.pid, recovered.pid]).size).toBe(3);
      expect(recovered.rejected).toBe(true);
      expect(recovered.effects).toBe(decision === 'approve' ? 1 : 0);
      expect(recovered.decisions).toEqual([
        { state: decision === 'interrupt' ? 'interrupted' : 'consumed' },
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);
