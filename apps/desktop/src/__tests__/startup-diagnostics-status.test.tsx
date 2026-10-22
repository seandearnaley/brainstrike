// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type DiagnosticEvent, serializeDiagnosticEventLine } from '@brainstrike/utils/diagnostics';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const logs = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({ app: { getPath: () => logs.path } }));

beforeEach(async () => {
  logs.path = await mkdtemp(join(tmpdir(), 'startup-diagnostics-'));
});
afterEach(async () => {
  cleanup();
  Reflect.deleteProperty(window, 'desktopDiagnostics');
  Reflect.deleteProperty(window, 'logging');
  await rm(logs.path, { force: true, recursive: true });
});

function event(id: string, occurredAt: number): DiagnosticEvent {
  return {
    appVersion: '1.0.0',
    causeChain: null,
    code: 'env_file_invalid',
    context: null,
    fingerprint: 'fp-env',
    id,
    message: 'Desktop environment file rejected',
    occurredAt,
    platform: 'darwin',
    resourceId: null,
    rootId: null,
    runId: null,
    scope: 'DesktopMain',
    sessionId: 'session-1',
    severity: 'error',
    source: 'electron-main',
    stack: null,
    threadId: null,
  };
}

test('an error Main logged before the window loaded shows in the status bar, and an earlier launch does not', async () => {
  // This process stands in for Main: it started at `performance.timeOrigin`.
  await writeFile(
    join(logs.path, 'brainstrike-errors.ndjson'),
    `${[
      event('previous-launch', performance.timeOrigin - 60_000),
      event('startup', performance.timeOrigin + 1),
    ]
      .map(serializeDiagnosticEventLine)
      .join('\n')}\n`
  );
  const { mainDiagnosticEventsReader } = await import('../assistant-server/query-diagnostics-tool');
  Object.defineProperty(window, 'desktopDiagnostics', {
    configurable: true,
    value: { getUnseenCounts: mainDiagnosticEventsReader.getUnseenCounts },
  });
  Object.defineProperty(window, 'logging', {
    configurable: true,
    value: { onDurableRecord: () => () => undefined },
  });

  // The window loads after Main logged the error.
  const { DiagnosticsStatusItem } = await import('@brainstrike/app-shell');
  render(<DiagnosticsStatusItem />);

  expect(await screen.findByTestId('diagnostics-status-item')).toHaveTextContent('1 error');
});
