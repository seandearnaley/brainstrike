// @vitest-environment node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const desktopDirectory = path.resolve(import.meta.dirname, '../..');
const ownerPath = path.resolve(import.meta.dirname, '../maintenance-trigger-runtime.ts');
const effectKitPath = path.resolve(
  import.meta.dirname,
  '../../../../packages/effect-kit/src/index.ts'
);
let childCode: string;

beforeAll(async () => {
  const entry = `
    import { createMaintenanceTriggerRuntime } from ${JSON.stringify(ownerPath)};

    const scenario = process.argv[2];
    const initialDelayMs = scenario === 'initial' ? 60_000 : 0;
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    let watchdog = null;

    globalThis.setTimeout = (...args) => {
      const handle = originalSetTimeout(...args);
      if (scenario === 'initial' && args[1] === 60_000) {
        process.stdout.write('INITIAL_ARMED\\n');
      }
      return handle;
    };
    globalThis.setInterval = (...args) => {
      const handle = originalSetInterval(...args);
      if (scenario === 'recurring' && args[1] === 60_000) {
        process.stdout.write('INTERVAL_ARMED\\n');
      }
      return handle;
    };

    if (scenario === 'recurring') {
      watchdog = originalSetTimeout(() => {
        process.stderr.write('Initial tick did not run\\n');
        process.exitCode = 1;
      }, 1_000);
    }

    const runtime = createMaintenanceTriggerRuntime({
      initialDelayMs,
      intervalMs: 60_000,
      onCloseError: (error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
      },
      tick: () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        process.stdout.write('TICK\\n');
      },
    });
    await runtime.start();
  `;
  const output = await build({
    alias: { '@brainstrike/effect-kit': effectKitPath },
    bundle: true,
    format: 'esm',
    platform: 'node',
    stdin: {
      contents: entry,
      loader: 'ts',
      resolveDir: desktopDirectory,
      sourcefile: 'maintenance-trigger-child.ts',
    },
    write: false,
  });
  const file = output.outputFiles[0];
  if (!file) {
    throw new Error('Maintenance trigger child build emitted no JavaScript');
  }
  childCode = file.text;
});

async function runChild(scenario: 'initial' | 'recurring'): Promise<string> {
  const execution = execFileAsync(process.execPath, ['--input-type=module', '-', scenario], {
    cwd: desktopDirectory,
    timeout: 2500,
  });
  const input = execution.child.stdin;
  if (!input) {
    execution.child.kill();
    throw new Error('Maintenance trigger child requires a stdin pipe');
  }
  try {
    const [, result] = await Promise.all([pipeline(Readable.from([childCode]), input), execution]);
    expect(result.stderr).toBe('');
    return result.stdout;
  } finally {
    if (execution.child.exitCode === null && execution.child.signalCode === null) {
      execution.child.kill();
    }
  }
}

describe('maintenance trigger process lifetime', () => {
  it('exits naturally with the initial timer armed', async () => {
    expect(await runChild('initial')).toBe('INITIAL_ARMED\n');
  });

  it('exits naturally with the recurring timer armed after its first tick', async () => {
    expect(await runChild('recurring')).toBe('TICK\nINTERVAL_ARMED\n');
  });
});
