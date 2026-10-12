import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { QueryRequest } from '../protocol.js';
import { spawnUtilityQueryProcess } from '../utility-process.js';

// Same utilityProcess event/IPC boundary exercised by test/electron-utility.cjs.
function utilityHost() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    pid: 123,
    postMessage: vi.fn<(request: QueryRequest) => void>(),
  });
}

describe('utility reader ownership', () => {
  it('forwards requests and diagnostics, releases listeners, and never kills a retired owner', async () => {
    const host = utilityHost();
    const fork = vi.fn(() => host);
    const process = spawnUtilityQueryProcess(fork);
    expect(fork).toHaveBeenCalledWith(expect.stringMatching(/utility-query-host\.js$/u));
    expect(process.pid).toBe(host.pid);
    const request: QueryRequest = { databasePath: '/owned/index.sqlite', id: 1, kind: 'open' };
    process.postMessage(request);
    expect(host.postMessage).toHaveBeenCalledWith(request);
    const message = vi.fn();
    const error = vi.fn();
    const exit = vi.fn();
    const offMessage = process.onMessage(message);
    const offError = process.onError(error);
    const offExit = process.onExit(exit);
    const response = { id: 1, kind: 'ready' };
    host.emit('message', response);
    expect(message).toHaveBeenCalledWith(response);
    host.emit('error', 'FatalError', 'sqlite', 'reader unavailable');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('reader unavailable') })
    );
    offMessage();
    offError();
    offExit();
    expect(host.listenerCount('message')).toBe(0);
    expect(host.listenerCount('error')).toBe(0);
    host.emit('exit');
    expect(exit).not.toHaveBeenCalled();
    expect(host.listenerCount('exit')).toBe(0);
    process.kill();
    expect(host.kill).not.toHaveBeenCalled();
    const lateExit = vi.fn();
    const offLateExit = process.onExit(lateExit);
    await Promise.resolve();
    expect(lateExit).toHaveBeenCalledOnce();
    offLateExit();
  });

  it('retains a failed retirement for retry and joins the eventual utility exit', () => {
    const host = utilityHost();
    host.kill.mockReturnValueOnce(false);
    const process = spawnUtilityQueryProcess(() => host, '/owned/utility-query-host.js');
    const exit = vi.fn();
    const offExit = process.onExit(exit);
    expect(() => process.kill()).toThrow();
    expect(exit).not.toHaveBeenCalled();
    process.kill();
    expect(host.kill).toHaveBeenCalledTimes(2);
    host.emit('exit');
    expect(exit).toHaveBeenCalledOnce();
    offExit();
    expect(host.listenerCount('exit')).toBe(0);
  });
});
