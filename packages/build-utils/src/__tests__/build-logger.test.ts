import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuildLogger } from '../build-logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createBuildLogger', () => {
  it('writes debug messages with structured metadata to stdout', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createBuildLogger('BuildScope');

    logger.debug('compiled asset', { asset: 'main.js', size: 42 });

    expect(stdoutWrite).toHaveBeenCalledWith(
      '[BuildScope] DEBUG compiled asset {"asset":"main.js","size":42}\n'
    );
  });

  it('writes warning messages without metadata to stderr', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createBuildLogger('BuildScope');

    logger.warn('missing optional file');

    expect(stderrWrite).toHaveBeenCalledWith('[BuildScope] WARN missing optional file\n');
  });
});
