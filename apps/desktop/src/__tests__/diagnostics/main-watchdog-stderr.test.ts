import { describe, expect, it, vi } from 'vitest';

import { writeMainWatchdogStderrRecord } from '../../diagnostics/main-watchdog-stderr';

describe('main watchdog stderr writer', () => {
  it('retries bounded EAGAIN failures and then writes the complete record', () => {
    const write = vi
      .fn<() => number>()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
      })
      .mockReturnValue(7);
    const wait = vi.fn();

    writeMainWatchdogStderrRecord('record\n', { wait, write });

    expect(write).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('continues from the byte offset returned by a partial write', () => {
    const write = vi.fn<(chunk: unknown) => number>().mockReturnValueOnce(4).mockReturnValueOnce(3);
    const wait = vi.fn();

    writeMainWatchdogStderrRecord('😀ok\n', { wait, write });

    expect(write).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(Buffer.from(write.mock.calls[0]?.[0] as Uint8Array).toString()).toBe('😀ok\n');
    expect(Buffer.from(write.mock.calls[1]?.[0] as Uint8Array).toString()).toBe('ok\n');
  });

  it('resets the stall budget whenever a partial write makes progress', () => {
    const write = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);

    writeMainWatchdogStderrRecord('ok', { wait: vi.fn(), write });

    expect(write).toHaveBeenCalledTimes(6);
  });

  it('surfaces a record that remains stalled after the bounded attempts', () => {
    const write = vi.fn(() => 0);

    expect(() => writeMainWatchdogStderrRecord('record\n', { wait: vi.fn(), write })).toThrow(
      'Main watchdog stderr record remained stalled after 3 attempts'
    );
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('surfaces a record that exceeds the absolute write-call bound despite progress', () => {
    const write = vi.fn(() => 1);

    expect(() => writeMainWatchdogStderrRecord('x'.repeat(65), { wait: vi.fn(), write })).toThrow(
      'Main watchdog stderr record exceeded 64 write calls'
    );
    expect(write).toHaveBeenCalledTimes(64);
  });

  it('rejects an invalid write count without retrying', () => {
    const write = vi.fn(() => 99);
    const wait = vi.fn();

    expect(() => writeMainWatchdogStderrRecord('record\n', { wait, write })).toThrow(
      'Invalid main watchdog stderr write count: 99'
    );
    expect(write).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it('rethrows non-EAGAIN failures without retrying', () => {
    const failure = Object.assign(new Error('broken fd'), { code: 'EBADF' });
    const write = vi.fn(() => {
      throw failure;
    });

    expect(() => writeMainWatchdogStderrRecord('record\n', { wait: vi.fn(), write })).toThrow(
      failure
    );
    expect(write).toHaveBeenCalledOnce();
  });
});
