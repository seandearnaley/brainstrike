import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('API keys settings category module boundary', () => {
  it('keeps the category factory out of the SettingsPageContent component module', async () => {
    const settingsPageSource = await readFile(
      resolve(process.cwd(), 'src/settings-page-content.tsx'),
      'utf8'
    );

    expect(settingsPageSource).not.toContain('createApiKeysSettingsCategory');

    const categorySource = await readFile(
      resolve(process.cwd(), 'src/settings/secrets/api-keys-settings-category.tsx'),
      'utf8'
    );
    expect(categorySource).toContain('export function createApiKeysSettingsCategory');
  });
});
