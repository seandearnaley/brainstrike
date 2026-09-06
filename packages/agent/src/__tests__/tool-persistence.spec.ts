/**
 * Unit coverage for the tool-preference load result (BST-1615).
 *
 * `loadToolPreferences` used to return `undefined` for three unrelated
 * outcomes — file absent, file corrupt, and an unexpected read failure — so
 * every caller was forced to treat "the user has no preferences yet" and "we
 * could not read the user's preferences" as the same thing. These tests pin
 * the discriminated result that keeps them apart.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type FileSystemAdapter,
  loadToolPreferences,
  type ToolPreferences,
} from '../mcp/tool-persistence';

const PREFS_PATH = '/user-data/mcp/tool-preferences.json';

function createFs(readFile: FileSystemAdapter['readFile']): FileSystemAdapter {
  return {
    dirname: (filePath) => filePath.slice(0, filePath.lastIndexOf('/')),
    join: (...segments) => segments.join('/'),
    mkdir: vi.fn(async () => undefined),
    readFile,
    unlink: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  };
}

function enoent(): NodeJS.ErrnoException {
  const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

const storedPreferences: ToolPreferences = {
  disabledTools: ['server.dangerous'],
  enabledTools: ['server.safe'],
  lastUpdated: 42,
  version: 1,
};

describe('loadToolPreferences result discrimination', () => {
  it('reports a missing file as absent, not as failure', async () => {
    const fs = createFs(async () => {
      throw enoent();
    });

    await expect(loadToolPreferences('/user-data', fs)).resolves.toEqual({
      path: PREFS_PATH,
      status: 'absent',
    });
  });

  it('reports a stored file as loaded with its preferences', async () => {
    const fs = createFs(async () => JSON.stringify(storedPreferences));

    await expect(loadToolPreferences('/user-data', fs)).resolves.toEqual({
      path: PREFS_PATH,
      preferences: storedPreferences,
      status: 'loaded',
    });
  });

  it('reports malformed JSON as invalid, distinct from absent', async () => {
    const fs = createFs(async () => '{"enabledTools":');

    const result = await loadToolPreferences('/user-data', fs);

    expect(result.status).toBe('invalid');
    expect(result).toMatchObject({ path: PREFS_PATH });
  });

  it('reports a schema-violating file as invalid, distinct from absent', async () => {
    const fs = createFs(async () =>
      JSON.stringify({
        disabledTools: ['server.dangerous'],
        enabledTools: ['server.safe'],
        lastUpdated: 'not-a-number',
        version: '1',
      })
    );

    const result = await loadToolPreferences('/user-data', fs);

    expect(result.status).toBe('invalid');
  });

  it('reports a non-ENOENT read failure as unreadable, distinct from absent and invalid', async () => {
    const fs = createFs(async () => {
      const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    const result = await loadToolPreferences('/user-data', fs);

    expect(result.status).toBe('unreadable');
    expect(result).toMatchObject({ path: PREFS_PATH, reason: expect.stringContaining('EACCES') });
  });
});
