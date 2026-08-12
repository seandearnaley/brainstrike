import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readDesktopSource(relativePath: string): string {
  return readFileSync(path.resolve(import.meta.dirname, '../..', relativePath), 'utf8');
}

describe('renderer tool execution IPC boundary', () => {
  it('does not register the legacy tools execution handler in production main', () => {
    const mainSource = readDesktopSource('main.ts');

    expect(mainSource).not.toContain("from './ipc-tools'");
    expect(mainSource).not.toContain('registerToolsIpcHandlers');
  });

  it('does not expose tool execution from the visible renderer preload', () => {
    const preloadSource = readDesktopSource('preload.ts');
    const channelCatalogSource = readDesktopSource('platform/desktop-ipc-channels.ts');

    expect(preloadSource).not.toContain("const TOOLS_EXECUTE_CHANNEL = 'tools:execute'");
    expect(preloadSource).not.toContain('ipcRenderer.invoke(TOOLS_EXECUTE_CHANNEL');
    expect(channelCatalogSource).not.toContain("execute: 'tools:execute'");
  });

  it('does not offer the legacy tool playground execution operation on desktop', () => {
    const settingsSource = readDesktopSource('renderer/components/settings/page-content.tsx');

    expect(settingsSource).not.toContain('executeToolTest:');
    expect(settingsSource).not.toContain('window.tools.execute');
  });
});
