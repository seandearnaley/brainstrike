import '@testing-library/jest-dom/vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createProvidersSettingsCategory } from '../providers-settings-category';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const noopVerifier = () => new Promise<never>(() => undefined);

describe('createProvidersSettingsCategory', () => {
  it('describes the unified Provider Hub category', () => {
    const category = createProvidersSettingsCategory({ verifyProvider: noopVerifier });

    expect(category.id).toBe('providers');
    expect(category.title).toBe('Providers');
    expect(category.description).toMatch(/credential|connect/i);
    // The old "API Keys" search terms must still find this surface.
    expect(category.keywords).toEqual(expect.arrayContaining(['api', 'keys', 'credentials']));
    expect(isValidElement(category.content)).toBe(true);
  });
});

describe('Providers settings category module boundary', () => {
  it('keeps the category factory out of the SettingsPageContent component module', async () => {
    const settingsPageSource = await readFile(
      resolve(SRC_ROOT, 'settings-page-content.tsx'),
      'utf8'
    );
    expect(settingsPageSource).not.toContain('createProvidersSettingsCategory');

    const categorySource = await readFile(
      resolve(SRC_ROOT, 'settings/providers/providers-settings-category.tsx'),
      'utf8'
    );
    expect(categorySource).toContain('export function createProvidersSettingsCategory');
  });

  // The per-provider-branch guard lives in `provider-branch-guard.test.ts`:
  // it covers BOTH provider trees, derives its provider ids from the registry,
  // tokenises rather than regex-stripping comments, and proves it can fail by
  // re-scanning every covered file with a branch spliced in.
});
