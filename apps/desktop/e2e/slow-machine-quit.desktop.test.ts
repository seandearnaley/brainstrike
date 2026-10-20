import { once } from 'node:events';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppHost } from './utils/agent-host-log';

/**
 * ADR-0026 R4: quit is one ordered, joined retirement with no global deadline. A renderer that
 * takes 12 s to flush and an agent host that takes 4 s to exit, each longer than the step
 * deadline Main used to race (10 s on Windows, 5 s elsewhere), still end in exit code 0, with
 * every step, the physical native joins included, settled successfully and no error-level record.
 * Both delays are the E2E lifecycle seam's Main-side points (`lifecycle-delay-seam.ts`): the
 * renderer's ACK reaches Main 12 s late, and Main observes its host's exit 4 s late.
 */
const RENDERER_FLUSH_MS = 12_000;
const CHILD_EXIT_MS = 4000;

test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_LIFECYCLE_DELAYS: `renderer-flush:${RENDERER_FLUSH_MS},child-exit:${CHILD_EXIT_MS}`,
    LOG_LEVEL: 'info',
  },
});

interface ShutdownStepRecord {
  readonly elapsedMs: number;
  readonly failed: boolean;
  readonly step: string;
}

interface LogRecord {
  readonly level?: number;
  readonly msg?: string;
  readonly step?: string;
  readonly steps?: readonly ShutdownStepRecord[];
}

/** Main's structured stdout records; the last segment is a line still being written. */
function parse(output: string): LogRecord[] {
  return output
    .split('\n')
    .slice(0, -1)
    .flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      return typeof record === 'object' && record !== null ? [record as LogRecord] : [];
    });
}

test('a 12 s renderer flush and a 4 s host exit still quit with exit 0 after every joined step', async ({
  electron,
}, testInfo) => {
  const page = await electron.ensureWindow();
  // The host is running, so quit joins its exit through the close ladder.
  await waitForAppHost(page);
  const main = (await electron.ensureContext()).app.process();
  let output = '';
  main.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  try {
    // 'close' follows the exit once the process's output streams have ended.
    await Promise.all([once(main, 'close'), electron.dispose()]);
  } finally {
    await testInfo.attach('slow-machine-quit-process-log', {
      body: output,
      contentType: 'text/plain',
    });
  }

  expect({ code: main.exitCode, signal: main.signalCode }).toEqual({ code: 0, signal: null });
  const records = parse(output);
  const reports = records.flatMap((record) =>
    record.msg === 'Graceful shutdown completed' && record.steps ? [record.steps] : []
  );
  expect(reports).toHaveLength(1);
  const steps = reports[0] ?? [];
  expect(steps.filter((step) => step.failed)).toEqual([]);
  // Every physical native join ran after the slow renderer instead of being skipped.
  expect(steps.map((step) => step.step)).toEqual(
    expect.arrayContaining([
      'renderers',
      'native-index',
      'file-system',
      'notes-vault',
      'chunking-host',
      'parser-host',
      'embedding-host',
      'git-commands',
      'database-close',
    ])
  );
  const elapsed = (name: string): number =>
    steps.find((step) => step.step === name)?.elapsedMs ?? Number.NaN;
  // The delays were in the joined path: the renderer's ACK and the host's exit.
  expect(elapsed('renderers')).toBeGreaterThanOrEqual(RENDERER_FLUSH_MS);
  expect(elapsed('native-index')).toBeGreaterThanOrEqual(CHILD_EXIT_MS);
  // A slow step is a warn naming it, never a failure or a forced exit.
  expect(
    records.flatMap((record) =>
      record.msg === 'Graceful shutdown step is slow' ? [record.step] : []
    )
  ).toContain('renderers');
  expect(records.map((record) => record.msg)).not.toContain(
    'Graceful shutdown completed with cleanup failures'
  );
  expect(records.filter((record) => (record.level ?? 0) >= 50)).toEqual([]);
});
