import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from './fixtures/electron-fixture';
import { seedPausedWorkspace } from './utils/foreground-latency-bench';
import {
  closeIndexingPopover,
  configureNativeIndex,
  openResumeControl,
  waitForReadyIndex,
} from './utils/native-index-build';

/**
 * A SIGTERM to Main's whole process group right after a native scan completes shuts down with
 * no failed step and no forced exit (BST-2135). A tty Ctrl+C or a tree kill signals every
 * process in the group, so the indexer utility, the embedding host renderer and the visible
 * renderer exit on the signal while Main is still retiring them. The signal arrives twice, as a
 * dev tree delivers it.
 */
test.use({ electronEnv: { LOG_LEVEL: 'info' } });
test.skip(process.platform === 'win32', 'Windows has no catchable POSIX process signals.');

const CLOSE_TIMEOUT_MS = 15_000;
const FILE_COUNT = 3;
const ROOT_ID = 'native-shutdown-signal-root';

let rootDir = '';

interface LogRecord {
  readonly level?: number;
  readonly msg?: string;
  readonly reason?: string;
  readonly receipt?: {
    readonly scanComplete?: boolean;
    readonly ticket?: { scope?: { kind?: string } };
  };
  readonly scope?: string;
  readonly steps?: readonly { readonly failed: boolean; readonly step: string }[];
}

interface Capture {
  read(): { output: string; records: LogRecord[] };
  waitFor(match: (record: LogRecord) => boolean, timeoutMs: number): Promise<void>;
}

function parse(output: string): LogRecord[] {
  // The last segment is a line still being written.
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

/** Main's structured stdout from now on, with a wait for a record that matches. */
function capture(mainProcess: ChildProcess): Capture {
  let output = '';
  const listeners = new Set<() => void>();
  mainProcess.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
    for (const listener of listeners) {
      listener();
    }
  });
  const read = () => ({ output, records: parse(output) });
  return {
    read,
    waitFor: (match, timeoutMs) =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          if (read().records.some(match)) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error('Timed out waiting for a Main log record.'));
        }, timeoutMs);
        listeners.add(check);
        check();
      }),
  };
}

function signalGroup(leaderPid: number): void {
  try {
    process.kill(-leaderPid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * A renderer the group signal killed, as its own owner logs it at error. That classification
 * sits outside the shutdown steps this spec covers; every other level-50 record fails it.
 */
function isSignalKilledRenderer(record: LogRecord): boolean {
  return (
    record.reason === 'killed' &&
    ((record.scope === 'CreateWindow' && record.msg === 'Renderer process gone') ||
      (record.scope === 'EmbeddingHostManager' &&
        record.msg === 'embedding-host renderer exited (killed, code 15)'))
  );
}

test.beforeAll(() => {
  // The host records the folder's real path (macOS tmpdir is a symlink).
  rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'brainstrike-shutdown-signal-')));
  mkdirSync(path.join(rootDir, 'notes'));
  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeFileSync(
      path.join(rootDir, 'notes', `note-${index}.md`),
      `# Note ${index}\n\nA short note about topic ${index}, kept small so its vectors embed fast.\n`
    );
  }
});

test.afterAll(() => {
  rmSync(rootDir, { force: true, recursive: true });
});

// At the workspace receipt the collection scan and reverification are still running; by 1 s the
// index is idle. The ticket's own repro signalled about 0.2 s after the index reported complete.
for (const delayMs of [0, 300, 1000]) {
  test(`@desktop-embedding-native-shutdown a SIGTERM to Main's process group ${delayMs} ms after the native scan completes fails no shutdown step`, async ({
    electron,
    window: page,
  }, testInfo) => {
    test.setTimeout(8 * 60 * 1000);
    await seedPausedWorkspace(page, [{ path: rootDir, rootId: ROOT_ID }], 'wasm', 'shutdown');
    await configureNativeIndex(page, 'wasm');
    await waitForReadyIndex(page, 300_000);
    const main = (await electron.ensureContext()).app.process();
    const pid = main.pid;
    if (pid === undefined) {
      throw new Error('The Electron main process has no pid');
    }
    const log = capture(main);
    const resume = await openResumeControl(page);
    await resume.click();
    await closeIndexingPopover(page);
    await log.waitFor(
      (record) =>
        record.msg === 'Canonical native scan settled' &&
        record.receipt?.scanComplete === true &&
        record.receipt.ticket?.scope?.kind === 'workspace',
      300_000
    );
    await delay(delayMs);

    let ended: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null =
      null;
    try {
      await electron.endOutOfBand(async (mainProcess) => {
        const closed = once(mainProcess, 'close', {
          signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
        });
        // Playwright launches Main as its process group's leader.
        signalGroup(pid);
        await log.waitFor(
          (record) => record.msg?.startsWith('Received shutdown signal') === true,
          5000
        );
        signalGroup(pid);
        await closed;
        ended = { code: mainProcess.exitCode, signal: mainProcess.signalCode };
      });
    } finally {
      await testInfo.attach('native-shutdown-signal-process-log', {
        body: log.read().output,
        contentType: 'text/plain',
      });
    }

    const { records } = log.read();
    const after = records.slice(
      records.findIndex((record) => record.msg?.startsWith('Received shutdown signal') === true)
    );
    const messages = after.map((record) => record.msg);
    expect(ended).toEqual({ code: 0, signal: null });
    expect(messages).toContain('Shutdown already in progress; ignoring signal');
    expect(messages).not.toContain('Timed out waiting for graceful shutdown; forcing exit');
    expect(messages).not.toContain('Graceful shutdown completed with cleanup failures');
    expect(
      after.filter((record) => (record.level ?? 0) >= 50 && !isSignalKilledRenderer(record))
    ).toEqual([]);
    const reports = after.flatMap((record) =>
      record.msg === 'Graceful shutdown completed' && record.steps ? [record.steps] : []
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.map((step) => step.step)).toEqual(
      expect.arrayContaining(['renderers', 'native-index', 'embedding-host', 'database-close'])
    );
    expect(reports[0]?.filter((step) => step.failed)).toEqual([]);
  });
}
