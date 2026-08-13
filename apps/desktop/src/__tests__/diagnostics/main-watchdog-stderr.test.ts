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
