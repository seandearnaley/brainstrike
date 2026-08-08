import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function readSource(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), 'utf8');
}

describe('logging component boundaries', () => {
  it('keeps LoggingSettingsSection focused on composition', async () => {
    const source = await readSource('src/settings/system/logging-settings-section.tsx');
    const start = source.indexOf('export function LoggingSettingsSection');
    const end = source.indexOf('interface GeneralLoggingCardProps');

    expect(source.slice(start, end).split('\n').length).toBeLessThanOrEqual(300);
  });

  it('keeps LogViewer below the giant-component threshold', async () => {
    const source = await readSource('src/settings/system/log-viewer-components/log-viewer.tsx');
    const componentSource = source.slice(source.indexOf('export function LogViewer'));

    expect(componentSource.split('\n').length).toBeLessThanOrEqual(300);
  });
});
