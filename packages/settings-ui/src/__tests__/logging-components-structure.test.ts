// @vitest-environment node
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

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // React Doctor's no-giant-component rule flags components above 300 lines.
    expect(source.slice(start, end).split('\n').length).toBeLessThanOrEqual(300);
  });

  it('keeps LogViewer below the giant-component threshold', async () => {
    const source = await readSource('src/settings/system/log-viewer-components/log-viewer.tsx');
    const start = source.indexOf('export function LogViewer');

    expect(start).toBeGreaterThanOrEqual(0);
    // React Doctor's no-giant-component rule flags components above 300 lines.
    const componentSource = source.slice(start);
    expect(componentSource.split('\n').length).toBeLessThanOrEqual(300);
  });
});
