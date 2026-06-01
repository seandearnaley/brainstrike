import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultToolPreferences,
  deleteToolPreferences,
  loadToolPreferences,
  saveToolPreferences,
  type ToolPreferences,
} from '../mcp/tool-persistence';

const createPreferences = (): ToolPreferences => ({
  enabledTools: ['search', 'files'],
  disabledTools: ['shell'],
  version: 2,
  lastUpdated: 123,
});

describe('tool-persistence', () => {
  let userDataDir = '';

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'tool-prefs-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('returns undefined when preference file does not exist', async () => {
    await expect(loadToolPreferences(userDataDir)).resolves.toBeUndefined();
  });

  it('saves and loads preferences from disk', async () => {
    const preferences = createPreferences();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    await saveToolPreferences(userDataDir, preferences);
    const loaded = await loadToolPreferences(userDataDir);

    expect(loaded).toEqual({
      ...preferences,
      lastUpdated: 1_700_000_000_000,
    });
    nowSpy.mockRestore();
  });

  it('returns undefined for malformed JSON', async () => {
    const prefsPath = join(userDataDir, 'mcp', 'tool-preferences.json');
    await mkdir(join(userDataDir, 'mcp'), { recursive: true });
    await writeFile(prefsPath, '{"enabledTools":', 'utf-8');

    await expect(loadToolPreferences(userDataDir)).resolves.toBeUndefined();
  });

  it('returns undefined for invalid schema', async () => {
    const prefsPath = join(userDataDir, 'mcp', 'tool-preferences.json');
    await mkdir(join(userDataDir, 'mcp'), { recursive: true });
    await writeFile(
      prefsPath,
      JSON.stringify({
        enabledTools: ['search'],
        disabledTools: ['shell'],
        version: '2',
        lastUpdated: 'not-a-number',
      }),
      'utf-8'
    );

    await expect(loadToolPreferences(userDataDir)).resolves.toBeUndefined();
  });

  it('returns undefined when read fails with a non-ENOENT error', async () => {
    const fileRoot = join(userDataDir, 'not-a-directory');
    await writeFile(fileRoot, 'blocked', 'utf-8');

    await expect(loadToolPreferences(fileRoot)).resolves.toBeUndefined();
  });

  it('throws when save fails due to invalid directory path', async () => {
    const fileRoot = join(userDataDir, 'not-a-directory');
    await writeFile(fileRoot, 'blocked', 'utf-8');

    await expect(saveToolPreferences(fileRoot, createPreferences())).rejects.toBeInstanceOf(Error);
  });

  it('deletes an existing preferences file', async () => {
    await saveToolPreferences(userDataDir, createPreferences());
    const prefsPath = join(userDataDir, 'mcp', 'tool-preferences.json');

    await deleteToolPreferences(userDataDir);

    await expect(readFile(prefsPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('silently handles deleting a missing preferences file', async () => {
    await expect(deleteToolPreferences(userDataDir)).resolves.toBeUndefined();
  });

  it('creates default preferences', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_001);

    expect(createDefaultToolPreferences()).toEqual({
      enabledTools: [],
      disabledTools: [],
      version: 1,
      lastUpdated: 1_700_000_000_001,
    });

    nowSpy.mockRestore();
  });
});
