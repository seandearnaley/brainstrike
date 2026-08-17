import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

function readDesktopSource(relativePath: string): string {
  return readFileSync(path.resolve(import.meta.dirname, '../..', relativePath), 'utf8');
}

describe('renderer tool execution IPC boundary', () => {
  it('does not register the legacy tools execution handler in production main', () => {
    const mainSource = readDesktopSource('main.ts');

    expect(mainSource).not.toMatch(/(?:from|import\s*\()['"][./]*ipc-tools['"]/);
    expect(mainSource).not.toContain('registerToolsIpcHandlers');
  });

  it('does not expose tool execution from the visible renderer preload', () => {
    const preloadSource = readDesktopSource('preload.ts');

    expect(preloadSource).not.toContain('tools:execute');
    expect(JSON.stringify(DESKTOP_IPC_CHANNELS)).not.toContain('tools:execute');
  });

  it('does not offer the legacy tool playground execution operation on desktop', () => {
    const settingsSource = readDesktopSource('renderer/components/settings/page-content.tsx');

    expect(settingsSource).not.toContain('window.tools.execute');
  });
});
