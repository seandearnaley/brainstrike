import { once } from 'node:events';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppHost } from './utils/agent-host-log';

/**
 * ADR-0026 R4: quit is one joined retirement with no global deadline. On a slow machine (the
 * standard hosted runners) the renderer's flush and the agent host's exit are waited for, never
 * raced: quit ends in exit code 0 with no error-level record and no cleanup failure.
 */
test.use({ electronEnv: { LOG_LEVEL: 'info' } });

interface LogRecord {
  readonly level?: number;
  readonly msg?: string;
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

test('a quit joins the renderer flush and the host exit, and exits 0', async ({
  electron,
}, testInfo) => {
  const page = await electron.ensureWindow();
  // The host is running, so quit joins its exit.
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
  // A slow step is only waited for, never a failure or a forced exit.
  expect(records.map((record) => record.msg)).not.toContain(
    'Graceful shutdown completed with cleanup failures'
  );
  expect(records.filter((record) => (record.level ?? 0) >= 50)).toEqual([]);
});
