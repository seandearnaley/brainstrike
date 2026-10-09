import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpConfigFile,
  type LoadedMcpConfig,
  type McpConfigFile,
} from '../src/mcp/config-file.js';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMocks,
}));

// Mock fs modules
vi.mock('node:fs', () => ({
  default: {
    watch: vi.fn(),
  },
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
  },
}));

/** A fresh profile config file per test, as the host composes one per profile. */
let configFile: McpConfigFile;
const getMcpConfigPath = (): Promise<string> => configFile.path();
const loadMcpConfig = (): Promise<LoadedMcpConfig> => configFile.load();
const setCustomMcpConfigPath = (configPath: string | null): Promise<void> =>
  configFile.setCustomPath(configPath);
const watchMcpConfig: McpConfigFile['watch'] = (onChange) => configFile.watch(onChange);

// Typed helpers for mocked modules
const mockedFs = vi.mocked(fs as unknown as { watch: ReturnType<typeof vi.fn> });
const mockedFsp = vi.mocked(
  fsp as unknown as {
    mkdir: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
  }
);

type WatchCallback = (eventType: string, filename?: string) => void;

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function getWatchCallback(): WatchCallback {
  const watchCall = mockedFs.watch.mock.calls[0];
  if (!watchCall) {
    throw new Error('expected fs.watch call');
  }
  const callback = watchCall[1];
  if (typeof callback !== 'function') {
    throw new Error('expected fs.watch callback');
  }
  return callback as WatchCallback;
}

describe('MCP config file comprehensive tests', () => {
  const expectedMcpDir = path.join('/mock/user/data', 'mcp');
  const expectedMcpConfigPath = path.join(expectedMcpDir, 'mcp.config.json');

  beforeEach(async () => {
    vi.clearAllMocks();
    configFile = createMcpConfigFile('/mock/user/data');
    // Default behavior: custom path file does not exist
    mockedFsp.readFile.mockImplementation(async (path) => {
      if (path.toString().endsWith('mcp-custom-path.txt')) {
        const error: any = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      }
      return undefined as never;
    });
    // Ensure we start with a clean state for custom path
    try {
      await setCustomMcpConfigPath(null);
    } catch {
      // Ignore errors during reset
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getMcpConfigPath', () => {
    it('should return correct path', async () => {
      const configPath = await getMcpConfigPath();
      expect(configPath).toBe(expectedMcpConfigPath);
    });
  });

  describe('loadMcpConfig', () => {
    it('should load and parse config successfully', async () => {
      const mockConfig = {
        servers: [{ command: 'cmd', name: 'test', transport: 'stdio' }],
      };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(mockConfig) as never;
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.servers).toHaveLength(1);
      expect(result.loadedAt).toBeDefined();
      expect(fsp.readFile).toHaveBeenCalledWith(expectedMcpConfigPath, 'utf-8');
    });

    it('should handle file not found', async () => {
      type NodeError = Error & { code?: string };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        const error: NodeError = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(false);
      expect(result.config).toBeUndefined();
      expect(result.servers).toBeUndefined();
    });

    it('should handle no such file error message', async () => {
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        throw new Error('no such file or directory');
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(false);
    });

    it('should handle other errors', async () => {
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        throw new Error('Permission denied');
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(true);
      expect(result.config).toBeUndefined();
      expect(result.error).toContain('Permission denied');
    });

    it('should handle invalid JSON', async () => {
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return 'invalid json' as never;
      });

      const result = await loadMcpConfig();

      expect(result.exists).toBe(true);
      expect(result.error).toBeDefined();
    });
  });

  describe('watchMcpConfig', () => {
    let mockWatcher: { close: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      vi.useFakeTimers();
      mockWatcher = { close: vi.fn() };
      mockedFs.watch.mockReturnValue(mockWatcher as never);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should setup watcher and call onChange on config changes', async () => {
      const onChange = vi.fn();
      const mockConfig = {
        servers: [{ command: 'cmd', name: 'test', transport: 'stdio' }],
      };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(mockConfig) as never;
      });

      const watcher = await watchMcpConfig(onChange);

      // Simulate file change
      const watchCallback = getWatchCallback();
      watchCallback('change', 'mcp.config.json');

      // Advance timers to trigger debounced callback
      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).toHaveBeenCalled();
      const firstCall = onChange.mock.calls[0];
      if (!firstCall) {
        throw new Error('expected onChange call');
      }
      const callArg = firstCall[0];
      expect(callArg.exists).toBe(true);
      expect(callArg.config).toBeDefined();

      watcher.close();
      expect(mockWatcher.close).toHaveBeenCalled();
    });

    it('should ignore non-mcp.config.json file changes', async () => {
      const onChange = vi.fn();
      await watchMcpConfig(onChange);

      const watchCallback = getWatchCallback();
      watchCallback('change', 'other-file.json');

      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should watch the selected config basename for custom paths', async () => {
      const onChange = vi.fn();
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          return '/custom/location/custom-mcp.json' as never;
        }
        return JSON.stringify({
          servers: [{ command: 'cmd', name: 'test', transport: 'stdio' }],
        }) as never;
      });

      await watchMcpConfig(onChange);

      const watchCallback = getWatchCallback();

      watchCallback('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).not.toHaveBeenCalled();

      watchCallback('change', 'custom-mcp.json');
      await vi.advanceTimersByTimeAsync(100);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('should debounce rapid changes', async () => {
      const onChange = vi.fn();
      const mockConfig = {
        servers: [{ command: 'cmd', name: 'test', transport: 'stdio' }],
      };
      mockedFsp.readFile.mockImplementation(async (path) => {
        if (path.toString().endsWith('mcp-custom-path.txt')) {
          const error: any = new Error('File not found');
          error.code = 'ENOENT';
          throw error;
        }
        return JSON.stringify(mockConfig) as never;
      });

      await watchMcpConfig(onChange);

      const watchCallback = getWatchCallback();

      // Rapid changes
      watchCallback('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(50);
      watchCallback('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(50);
      watchCallback('change', 'mcp.config.json');

      // Only final timeout should trigger
      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('publishes only the latest event when config loads finish out of order', async () => {
      const firstRead = Promise.withResolvers<string>();
      let configReads = 0;
      mockedFsp.readFile.mockImplementation(async (filePath) => {
        if (filePath.toString().endsWith('mcp-custom-path.txt')) {
          const error = new Error('File not found') as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        }
        configReads += 1;
        if (configReads === 1) {
          return await firstRead.promise;
        }
        return JSON.stringify({
          servers: [{ command: 'second', name: 'second', transport: 'stdio' }],
        });
      });
      const onChange = vi.fn();
      await watchMcpConfig(onChange);
      const watchCallback = getWatchCallback();

      watchCallback('change', 'mcp.config.json');
      vi.advanceTimersByTime(100);
      await flushMicrotasks();
      expect(configReads).toBe(1);

      watchCallback('change', 'mcp.config.json');
      vi.advanceTimersByTime(100);
      await flushMicrotasks();
      expect(onChange).toHaveBeenCalledOnce();
      expect(onChange.mock.calls[0]?.[0].servers?.[0]?.name).toBe('second');

      firstRead.resolve(
        JSON.stringify({ servers: [{ command: 'first', name: 'first', transport: 'stdio' }] })
      );
      await flushMicrotasks();
      expect(onChange).toHaveBeenCalledOnce();
    });

    it('observes an async watcher callback rejection exactly once', async () => {
      const callbackError = new Error('projection failed');
      mockedFsp.readFile.mockResolvedValue(
        JSON.stringify({ servers: [{ command: 'cmd', name: 'test', transport: 'stdio' }] })
      );
      const onChange = vi.fn(async () => {
        throw callbackError;
      });
      await watchMcpConfig(onChange);

      getWatchCallback()('change', 'mcp.config.json');
      await vi.advanceTimersByTimeAsync(100);

      expect(loggerMocks.error).toHaveBeenCalledOnce();
      expect(loggerMocks.error).toHaveBeenCalledWith('MCP config watcher callback failed', {
        error: callbackError,
      });
    });

    it('serializes async watcher callbacks across separate events', async () => {
      let configReads = 0;
      mockedFsp.readFile.mockImplementation(async (filePath) => {
        if (filePath.toString().endsWith('mcp-custom-path.txt')) {
          const error = new Error('File not found') as Error & { code: string };
          error.code = 'ENOENT';
          throw error;
        }
        configReads += 1;
        return JSON.stringify({
          servers: [
            { command: 'cmd', name: configReads === 1 ? 'first' : 'second', transport: 'stdio' },
          ],
        });
      });
      const firstCallback = Promise.withResolvers<void>();
      const order: string[] = [];
      const onChange = vi.fn(async (config: LoadedMcpConfig) => {
        const name = config.servers?.[0]?.name ?? 'missing';
        order.push(`${name}:start`);
        if (name === 'first') {
          await firstCallback.promise;
        }
        order.push(`${name}:end`);
      });
      await watchMcpConfig(onChange);
      const watchCallback = getWatchCallback();

      watchCallback('change', 'mcp.config.json');
      vi.advanceTimersByTime(100);
      await flushMicrotasks();
      watchCallback('change', 'mcp.config.json');
      vi.advanceTimersByTime(100);
      await flushMicrotasks();

      expect(order).toEqual(['first:start']);
      firstCallback.resolve();
      await flushMicrotasks();
      expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('cancels pending debounce work when closed', async () => {
      const onChange = vi.fn();
      const watcher = await watchMcpConfig(onChange);

      getWatchCallback()('change', 'mcp.config.json');
      watcher.close();
      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).not.toHaveBeenCalled();
      expect(mockWatcher.close).toHaveBeenCalledOnce();
    });

    it('should handle undefined filename', async () => {
      const onChange = vi.fn();
      await watchMcpConfig(onChange);

      const watchCallback = getWatchCallback();
      watchCallback('change', undefined);

      await vi.advanceTimersByTimeAsync(100);

      expect(onChange).not.toHaveBeenCalled();
    });

    it('should ensure directory exists', async () => {
      await watchMcpConfig(vi.fn());
      // Wait a tick for the void ensureMcpDirExists() call to complete
      await vi.waitFor(() => {
        expect(fsp.mkdir).toHaveBeenCalledWith(expectedMcpDir, { recursive: true });
      });
    });
  });
});
