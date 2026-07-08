import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron before importing the module
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
  },
}));

// Import the module under test
import { getMcpConfigPath, setCustomMcpConfigPath } from '../mcp-loader';

describe('mcp-loader optimization', () => {
  const tmpDir = '/tmp/mcp';
  const customPathFile = path.join(tmpDir, 'mcp-custom-path.txt');

  beforeEach(async () => {
    // Clean up before each test
    await fsp.rm(tmpDir, { force: true, recursive: true });
    // Reset internal cache if possible (via setCustomMcpConfigPath(null))
    await setCustomMcpConfigPath(null);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { force: true, recursive: true });
  });

  it('should return default path when custom path file does not exist', async () => {
    const configPath = await getMcpConfigPath();
    expect(configPath).toBe(path.join(tmpDir, 'mcp.config.json'));
  });

  it('should return custom path when custom path file exists', async () => {
    const customConfigPath = '/custom/path/to/mcp.json';

    // Manually create the custom path file to simulate it existing on disk
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(customPathFile, customConfigPath, 'utf-8');

    // We need to clear the internal cache. setCustomMcpConfigPath sets the cache.
    // However, getMcpConfigPath reads from disk if cache is null.
    // So we reset cache to null first (which deletes the file, so we must write it AFTER resetting cache)
    await setCustomMcpConfigPath(null);

    // Write file again because setCustomMcpConfigPath(null) deleted it
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(customPathFile, customConfigPath, 'utf-8');

    const configPath = await getMcpConfigPath();
    expect(configPath).toBe(customConfigPath);
  });

  it('should handle setCustomMcpConfigPath correctly', async () => {
    const customConfigPath = '/another/custom/path.json';
    await setCustomMcpConfigPath(customConfigPath);

    // Verify file content
    const content = await fsp.readFile(customPathFile, 'utf-8');
    expect(content).toBe(customConfigPath);

    // Verify get returns it
    expect(await getMcpConfigPath()).toBe(customConfigPath);
  });

  it('should delete file when setting custom path to null', async () => {
    // First set it
    await setCustomMcpConfigPath('/some/path');
    expect(fs.existsSync(customPathFile)).toBe(true);

    // Then unset it
    await setCustomMcpConfigPath(null);
    expect(fs.existsSync(customPathFile)).toBe(false);
  });
});
