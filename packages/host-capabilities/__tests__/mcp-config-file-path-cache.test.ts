import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpConfigFile, type McpConfigFile } from '../src/mcp/config-file.js';

describe('MCP config file custom path cache', () => {
  let userDataDir: string;
  let customPathFile: string;
  let configFile: McpConfigFile;

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-config-path-'));
    customPathFile = path.join(userDataDir, 'mcp', 'mcp-custom-path.txt');
    configFile = createMcpConfigFile(userDataDir);
  });

  afterEach(async () => {
    await fsp.rm(userDataDir, { force: true, recursive: true });
  });

  it('returns the default path when no custom path file exists', async () => {
    expect(await configFile.path()).toBe(path.join(userDataDir, 'mcp', 'mcp.config.json'));
  });

  it('reads a custom path file created outside the app while the cache is unset', async () => {
    const customConfigPath = '/custom/path/to/mcp.json';
    // Settles the cache on "no custom path", then the file appears on disk.
    await configFile.setCustomPath(null);
    await fsp.mkdir(path.dirname(customPathFile), { recursive: true });
    await fsp.writeFile(customPathFile, customConfigPath, 'utf-8');

    expect(await configFile.path()).toBe(customConfigPath);
  });

  it('persists a selected custom path and returns it', async () => {
    const customConfigPath = '/another/custom/path.json';
    await configFile.setCustomPath(customConfigPath);

    expect(await fsp.readFile(customPathFile, 'utf-8')).toBe(customConfigPath);
    expect(await configFile.path()).toBe(customConfigPath);
  });

  it('deletes the custom path file when the selection is reset', async () => {
    await configFile.setCustomPath('/some/path');
    expect(fs.existsSync(customPathFile)).toBe(true);

    await configFile.setCustomPath(null);
    expect(fs.existsSync(customPathFile)).toBe(false);
  });
});
