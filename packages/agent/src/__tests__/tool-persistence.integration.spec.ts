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
  disabledTools: ['shell'],
  enabledTools: ['search', 'files'],
  lastUpdated: 123,
  version: 2,
});

describe('tool-persistence', () => {
  let userDataDir = '';

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'tool-prefs-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(userDataDir, { force: true, recursive: true });
  });

  it('reports absent when the preference file does not exist', async () => {
    await expect(loadToolPreferences(userDataDir)).resolves.toMatchObject({ status: 'absent' });
  });

  it('saves and loads preferences from disk', async () => {
    const preferences = createPreferences();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    await saveToolPreferences(userDataDir, preferences);
    const loaded = await loadToolPreferences(userDataDir);

    expect(loaded).toMatchObject({
      preferences: { ...preferences, lastUpdated: 1_700_000_000_000 },
      status: 'loaded',
    });
    nowSpy.mockRestore();
  });

  it('reports invalid for malformed JSON', async () => {
    const prefsPath = join(userDataDir, 'mcp', 'tool-preferences.json');
    await mkdir(join(userDataDir, 'mcp'), { recursive: true });
    await writeFile(prefsPath, '{"enabledTools":', 'utf-8');

    await expect(loadToolPreferences(userDataDir)).resolves.toMatchObject({ status: 'invalid' });
  });

  it('reports invalid for a schema-violating file', async () => {
    const prefsPath = join(userDataDir, 'mcp', 'tool-preferences.json');
    await mkdir(join(userDataDir, 'mcp'), { recursive: true });
    await writeFile(
      prefsPath,
      JSON.stringify({
        disabledTools: ['shell'],
        enabledTools: ['search'],
        lastUpdated: 'not-a-number',
        version: '2',
      }),
      'utf-8'
    );

    await expect(loadToolPreferences(userDataDir)).resolves.toMatchObject({ status: 'invalid' });
  });

  it('reports unreadable when the read fails with a non-ENOENT error', async () => {
    const fileRoot = join(userDataDir, 'not-a-directory');
    await writeFile(fileRoot, 'blocked', 'utf-8');

    await expect(loadToolPreferences(fileRoot)).resolves.toMatchObject({ status: 'unreadable' });
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
      disabledTools: [],
      enabledTools: [],
      lastUpdated: 1_700_000_000_001,
      version: 1,
    });

    nowSpy.mockRestore();
  });
});
