import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

it('retains a real broken-pipe transport failure without recursively logging into its worker', async () => {
  // Recorded Windows M3 failure: EPIPE followed by "the worker has exited".
  // Exercise the real built Pino worker and close its parent-owned pipe.
  const loggingUrl = pathToFileURL(resolve(import.meta.dirname, '../../dist/index.js')).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { addLogListener, configureLogger, createLogger, resetLogger } from ${JSON.stringify(loggingUrl)};
        configureLogger({ console: { enabled: true }, file: false });
        const logger = createLogger('BrokenPipe');
        const records = [];
        let uncaught = 0;
        process.on('uncaughtException', error => {
          if (++uncaught >= 10) process.exit(17);
          logger.error({ error }, 'Uncaught exception');
        });
        addLogListener(record => {
          records.push(record);
          if (record.message === 'Log transport failed') {
            logger.warn({ apiKey: 'private-test-value' }, 'Retained after failure');
            setImmediate(() => {
              resetLogger();
              process.send({ records, uncaught }, () => process.disconnect());
            });
          }
        });
        process.on('message', message => {
          if (message === 'closed') logger.info('Write to the closed pipe');
        });
        process.send('ready');
      `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }
  );
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  });
  const messages: unknown[] = [];
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  child.on('message', (message: unknown) => {
    if (message === 'ready') {
      child.stdout?.destroy();
      child.send('closed');
    } else {
      messages.push(message);
    }
  });
  const [code, signal] = await once(child, 'exit');
  expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: '' });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    records: expect.arrayContaining([
      expect.objectContaining({ level: 'error', message: 'Log transport failed', scope: 'Logger' }),
      expect.objectContaining({ level: 'warn', message: 'Retained after failure' }),
    ]),
    uncaught: 0,
  });
  expect(JSON.stringify(messages)).not.toContain('private-test-value');
});

it('keeps an explicit console threshold independent from retained log records', () => {
  const loggingUrl = pathToFileURL(resolve(import.meta.dirname, '../../dist/index.js')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { addLogListener, configureLogger, createLogger, LogLevel, resetLogger } from ${JSON.stringify(loggingUrl)};
        configureLogger({ console: { enabled: true, level: LogLevel.WARN }, file: false, level: LogLevel.INFO });
        const records = [];
        addLogListener(record => records.push(record.message));
        const logger = createLogger('Threshold');
        logger.info('Retained below console threshold');
        logger.warn('Visible console warning');
        resetLogger();
        process.stderr.write(JSON.stringify(records));
      `,
    ],
    { encoding: 'utf8', timeout: 3000, windowsHide: true }
  );

  expect(result.error).toBeUndefined();
  expect({ signal: result.signal, status: result.status }).toEqual({ signal: null, status: 0 });
  expect(JSON.parse(result.stderr)).toEqual([
    'Retained below console threshold',
    'Visible console warning',
  ]);
  expect(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).msg)
  ).toEqual(['Visible console warning']);
});
