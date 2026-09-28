import { EventEmitter } from 'node:events';
import { runShutdownSequence } from '@brainstrike/effect-kit';
import { expect, it, vi } from 'vitest';
import type { ParserHostParseRequest } from '../../parser-host-shared';

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ utilityProcess: { fork: forkMock } }));

class HeldParserProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}

it('keeps a held parser exit under the shutdown sequence deadline', async () => {
  const host = new HeldParserProcess();
  forkMock.mockReturnValue(host);
  const { ParserHostManager } = await import('../../parser-host-manager');
  const manager = new ParserHostManager({ entryPath: '/fake/entry.js' });
  const request: ParserHostParseRequest = {
    content: 'const value = 1;',
    options: { errorRecovery: true, jsx: false, language: 'javascript' },
    requestId: 'held-parser',
  };
  const parse = manager.parse(request);
  const later = vi.fn();
  const onDeadline = vi.fn();
  try {
    const report = await runShutdownSequence(
      [
        { name: 'parser-host', run: () => manager.stop() },
        { name: 'database', run: later },
      ],
      { deadlineMs: 20, onDeadline }
    );
    expect(report.timedOut).toBe(true);
    expect(onDeadline).toHaveBeenCalledWith(expect.objectContaining({ step: 'parser-host' }));
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    await expect(parse).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
    expect(host.listenerCount('exit')).toBe(1);
  } finally {
    host.emit('exit', 0);
    await manager.stop();
  }
  expect(host.listenerCount('exit')).toBe(0);
  expect(host.listenerCount('message')).toBe(0);
});

it('reports local timeout while later shutdown owners proceed and exit stays owned', async () => {
  const host = new HeldParserProcess();
  forkMock.mockReturnValue(host);
  const { ParserHostManager } = await import('../../parser-host-manager');
  const manager = new ParserHostManager({ entryPath: '/fake/entry.js', stopTimeoutMs: 20 });
  const parse = manager.parse({
    content: 'x',
    options: { errorRecovery: true, jsx: false, language: 'javascript' },
    requestId: 'local',
  });
  const database = vi.fn();
  const errorLog = vi.fn();
  const onDeadline = vi.fn();
  try {
    const report = await runShutdownSequence(
      [
        { name: 'parser-host', run: () => manager.stop() },
        { name: 'database', run: database },
        { name: 'error-log-sink', run: errorLog },
      ],
      { deadlineMs: 200, onDeadline }
    );
    expect(report.timedOut).toBe(false);
    expect(report.steps).toEqual([
      expect.objectContaining({
        error: new Error('parser host stop timeout after 20ms'),
        outcome: 'failed',
        step: 'parser-host',
      }),
      expect.objectContaining({ outcome: 'succeeded', step: 'database' }),
      expect.objectContaining({ outcome: 'succeeded', step: 'error-log-sink' }),
    ]);
    expect(database).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(onDeadline).not.toHaveBeenCalled();
    await expect(parse).resolves.toMatchObject({ error: 'parser host stopped', ok: false });
    expect(host.listenerCount('exit')).toBe(1);
    expect(host.listenerCount('message')).toBe(1);
    await expect(manager.stop()).rejects.toThrow('parser host stop timeout after 20ms');
    expect(host.kill).toHaveBeenCalledTimes(1);
  } finally {
    host.emit('exit', 0);
    await manager.stop();
  }
  expect(host.listenerCount('exit')).toBe(0);
  expect(host.listenerCount('message')).toBe(0);
});
