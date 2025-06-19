import { afterEach, describe, expect, it, vi } from 'vitest';
import * as envUtils from '../env-utils';
import { debug, error, warn } from '../logger';

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('logs to console when in development', () => {
    vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(true);
    debug('debug');
    warn('warn');
    error('error');
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not log when not in development', () => {
    vi.spyOn(envUtils, 'isDevEnv').mockReturnValue(false);
    debug('debug');
    warn('warn');
    error('error');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
