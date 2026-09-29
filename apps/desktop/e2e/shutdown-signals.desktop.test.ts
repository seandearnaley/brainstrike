import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/**
 * BST-1872 L2: every exit path reaches the database close. The dev tree (`pnpm dev` ->
 * turbo -> concurrently -> Electron) tears down by signalling EVERY process: `concurrently`
 * tree-kills main and each of its children, the DB host included, and the tty process group
 * delivers the same signal twice. Running the whole tree in CI is slow and flaky; the part under
 * our control is exactly this signal pattern, delivered here to the real app.
 */

const CLEAN_SHUTDOWN_MARKER = '.db-clean-shutdown';
const CLOSE_TIMEOUT_MS = 10_000;
const PROBE_ROW_ID = 'shutdown-signal-probe-row';

interface DatabaseIdentity {
  readonly appDataDir: string;
  readonly hostPid: number;
  readonly previousShutdown: string;
}

let previousLogLevel: string | undefined;

// The graceful-shutdown completion record is info-level; the `test:e2e` scripts run at `warn`.
test.beforeAll(() => {
  previousLogLevel = process.env['LOG_LEVEL'];
  process.env['LOG_LEVEL'] = 'info';
});

test.afterAll(() => {
  if (previousLogLevel === undefined) {
    delete process.env['LOG_LEVEL'];
  } else {
    process.env['LOG_LEVEL'] = previousLogLevel;
  }
});

/** Waits for the DB host to open the database, then reports where it lives and how it was last closed. */
async function waitForOpenDatabase(page: Page): Promise<DatabaseIdentity> {
  await expect
    .poll(async () => (await readDiagnostics(page)).previousShutdown, { timeout: 60_000 })
    .not.toBeNull();
  const { appDataDir, hostPid, previousShutdown } = await readDiagnostics(page);
  if (
    typeof appDataDir !== 'string' ||
    typeof hostPid !== 'number' ||
    typeof previousShutdown !== 'string'
  ) {
    throw new Error(
      `DB diagnostics lack the host identity: ${JSON.stringify({ appDataDir, hostPid, previousShutdown })}`
    );
  }
  return { appDataDir, hostPid, previousShutdown };
}

interface DiagnosticsProbe {
  readonly appDataDir: unknown;
  readonly hostPid: unknown;
  readonly previousShutdown: unknown;
}

async function readDiagnostics(page: Page): Promise<DiagnosticsProbe> {
  return await page.evaluate(async () => {
    const database = window.electronAPI?.db;
    if (!database?.diagnostics) {
      throw new Error('Desktop database diagnostics bridge is unavailable');
    }
    // `hostPid` is the manager's own field, beyond the snapshot the bridge types.
    const snapshot = (await database.diagnostics()) as unknown as Record<string, unknown>;
    return {
      appDataDir: snapshot['appDataDir'],
      hostPid: snapshot['hostPid'],
      previousShutdown: snapshot['previousShutdown'],
    };
  });
}

async function insertProbeRow(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const database = window.electronAPI?.db;
    if (!database) {
      throw new Error('Desktop database bridge is unavailable');
    }
    await database.query('CREATE TABLE IF NOT EXISTS shutdown_signal_probe (id text PRIMARY KEY)');
    await database.query('INSERT INTO shutdown_signal_probe (id) VALUES ($1)', [id]);
  }, PROBE_ROW_ID);
}

async function readProbeRowIds(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const database = window.electronAPI?.db;
    if (!database) {
      throw new Error('Desktop database bridge is unavailable');
    }
    const result = await database.query('SELECT id FROM shutdown_signal_probe');
    return result.rows.map((row) => String((row as { id: unknown }).id));
  });
}

function captureOutput(mainProcess: ChildProcess): () => string {
  const chunks: string[] = [];
  const capture = (chunk: Buffer) => chunks.push(chunk.toString());
  mainProcess.stdout?.on('data', capture);
  mainProcess.stderr?.on('data', capture);
  return () => chunks.join('');
}

/** A process that already exited is fine (the host closes and exits within milliseconds); anything else is not. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function requirePid(mainProcess: ChildProcess): number {
  if (mainProcess.pid === undefined) {
    throw new Error('The Electron main process has no pid');
  }
  return mainProcess.pid;
}

test.describe('Shutdown signals reach the database close', () => {
  test.setTimeout(240_000);

  test('a dev-tree teardown closes the database cleanly, and the next boot reads it as clean', async ({
    electron,
    window,
  }, testInfo) => {
    const { appDataDir, hostPid } = await waitForOpenDatabase(window);
    await insertProbeRow(window);
    const markerPath = path.join(appDataDir, CLEAN_SHUTDOWN_MARKER);
    // Opening removes the marker: a running session is unclean until it closes.
    expect(existsSync(markerPath)).toBe(false);

    let readOutput = () => '';
    let ended: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null =
      null;
    try {
      await electron.endOutOfBand(async (mainProcess) => {
        const mainPid = requirePid(mainProcess);
        readOutput = captureOutput(mainProcess);
        const closed = once(mainProcess, 'close', {
          signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
        });
        // What `concurrently`'s tree-kill and the tty group deliver: the host and main are both
        // signalled, main more than once, then again with SIGTERM.
        signal(hostPid, 'SIGINT');
        signal(mainPid, 'SIGINT');
        signal(mainPid, 'SIGINT');
        signal(hostPid, 'SIGTERM');
        signal(mainPid, 'SIGTERM');
        await closed;
        ended = { code: mainProcess.exitCode, signal: mainProcess.signalCode };
      });
    } finally {
      await testInfo.attach('shutdown-signals-process-log', {
        body: readOutput(),
        contentType: 'text/plain',
      });
    }

    const log = readOutput();
    expect(ended).toEqual({ code: 0, signal: null });
    expect(log).toContain('Received shutdown signal');
    expect(log).toContain('Shutdown already in progress; ignoring signal');
    expect(log).toContain('Graceful shutdown completed');
    expect(log).not.toContain('forcing exit');
    expect(existsSync(markerPath)).toBe(true);
    // Only the host writes the marker (main has no database to close by then), so its pid is the
    // proof the HOST closed itself. The host's own log line and lifecycle message are best effort:
    // a host that exits promptly can lose them, so nothing here depends on them.
    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toMatchObject({ pid: hostPid });

    const { waitForAppReady } = await loadElectronHelpers();
    const relaunched = await electron.restart();
    await waitForAppReady(relaunched.window);
    expect((await waitForOpenDatabase(relaunched.window)).previousShutdown).toBe('clean');
    expect(await readProbeRowIds(relaunched.window)).toEqual([PROBE_ROW_ID]);
  });

  test('negative control: a crash leaves no marker, and the next boot reads it as unclean', async ({
    electron,
    window,
  }) => {
    const { appDataDir, hostPid } = await waitForOpenDatabase(window);
    const markerPath = path.join(appDataDir, CLEAN_SHUTDOWN_MARKER);

    await electron.endOutOfBand(async (mainProcess) => {
      const mainPid = requirePid(mainProcess);
      const closed = once(mainProcess, 'close', { signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) });
      // Main first, so it can never fork a replacement host in the gap; then the host itself.
      signal(mainPid, 'SIGKILL');
      signal(hostPid, 'SIGKILL');
      await closed;
    });

    expect(existsSync(markerPath)).toBe(false);
    const { waitForAppReady } = await loadElectronHelpers();
    const relaunched = await electron.restart();
    await waitForAppReady(relaunched.window);
    expect((await waitForOpenDatabase(relaunched.window)).previousShutdown).toBe('unclean');
  });
});
