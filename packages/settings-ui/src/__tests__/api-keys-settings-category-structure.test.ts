import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('API keys settings category module boundary', () => {
  it('keeps the category factory out of the SettingsPageContent component module', async () => {
    const settingsPageSource = await readFile(
      resolve(SRC_ROOT, 'settings-page-content.tsx'),
      'utf8'
    );

    expect(settingsPageSource).not.toContain('createApiKeysSettingsCategory');
    expect(settingsPageSource).not.toMatch(/export function create\w+SettingsCategory/);

    const categorySource = await readFile(
      resolve(SRC_ROOT, 'settings/secrets/api-keys-settings-category.tsx'),
      'utf8'
    );
    expect(categorySource).toContain('export function createApiKeysSettingsCategory');
  });
});
