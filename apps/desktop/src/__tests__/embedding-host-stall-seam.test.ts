// @vitest-environment node

import { afterEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock('electron', () => electron);

import {
  createEmbeddingHostStallSeam,
  EMBEDDING_HOST_STALL_SEAM_ENV,
} from '../embedding-host-stall-seam';

afterEach(() => {
  electron.app.isPackaged = false;
  vi.unstubAllEnvs();
});

it('withholds exactly the first N document batches in an unpackaged test-mode launch', () => {
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
  const stall = createEmbeddingHostStallSeam({ [EMBEDDING_HOST_STALL_SEAM_ENV]: '2' });
  expect(['a', 'b', 'c', 'd'].map(stall)).toEqual([true, true, false, false]);
});

it('is inert in a packaged build, outside test mode, and without the variable', () => {
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
  electron.app.isPackaged = true;
  expect(createEmbeddingHostStallSeam({ [EMBEDDING_HOST_STALL_SEAM_ENV]: '1' })('request')).toBe(
    false
  );
  electron.app.isPackaged = false;
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'false');
  expect(createEmbeddingHostStallSeam({ [EMBEDDING_HOST_STALL_SEAM_ENV]: '1' })('request')).toBe(
    false
  );
  vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
  expect(createEmbeddingHostStallSeam({})('request')).toBe(false);
});

it('refuses a malformed count instead of ignoring it', () => {
  for (const raw of ['0', '-1', '1.5', 'yes', '']) {
    expect(() =>
      createEmbeddingHostStallSeam({ [EMBEDDING_HOST_STALL_SEAM_ENV]: raw }, () => true)
    ).toThrow(`${EMBEDDING_HOST_STALL_SEAM_ENV} must be a positive integer.`);
  }
});
