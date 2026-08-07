import { createHash } from 'node:crypto';
import { playwright as playwrightProvider } from '@vitest/browser-playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindTraceChunkNameBounding,
  boundTraceChunkName,
  createBrowserProject,
  createPlaywrightOptions,
  MAX_TRACE_CHUNK_NAME_LENGTH,
  playwright,
  type TraceChunkCommand,
} from '../src/vitest-browser';

const ENV_KEYS = ['CI', 'GITHUB_ACTIONS'] as const;
const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  CI: process.env['CI'],
  GITHUB_ACTIONS: process.env['GITHUB_ACTIONS'],
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (typeof value === 'string') {
      process.env[key] = value;
      continue;
    }
    Reflect.deleteProperty(process.env, key);
  }
});

describe('createPlaywrightOptions', () => {
  it('returns CI launch args when isCI is true', () => {
    const options = createPlaywrightOptions({ isCI: true });
    expect(options).toEqual({
      launchOptions: {
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--disable-features=VizDisplayCompositor',
        ],
      },
    });
  });

  it('returns empty options when no launch args are configured', () => {
    const options = createPlaywrightOptions({ isCI: false });
    expect(options).toEqual({});
  });

  it('detects CI mode from GITHUB_ACTIONS when CI is not set', () => {
    Reflect.deleteProperty(process.env, 'CI');
    process.env['GITHUB_ACTIONS'] = 'true';

    const options = createPlaywrightOptions();
    expect(options).toEqual({
      launchOptions: {
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-setuid-sandbox',
          '--disable-features=VizDisplayCompositor',
        ],
      },
    });
  });

  it('honors explicit isCI=false even when CI environment vars are present', () => {
    process.env['CI'] = '1';
    process.env['GITHUB_ACTIONS'] = 'true';

    const options = createPlaywrightOptions({ isCI: false });
    expect(options).toEqual({});
  });

  it('prefers explicit launch args over CI defaults', () => {
    const options = createPlaywrightOptions({
      isCI: true,
      launchArgs: ['--custom-flag'],
    });

    expect(options).toEqual({
      launchOptions: {
        args: ['--custom-flag'],
      },
    });
  });
});

describe('createBrowserProject', () => {
  it('builds browser project config with defaults in local mode', () => {
    const project = createBrowserProject({
      isCI: false,
    });

    expect(project.test.name).toBe('browser');
    expect(project.test.include).toEqual(['**/*.browser.test.{ts,tsx}']);
    expect(project.test.outputDir).toBe('test-results');
    expect(project.test.browser.enabled).toBe(true);
    expect(project.test.browser.headless).toBe(true);
    expect(project.test.browser.trace).toBe('off');
    expect(project.test.browser.instances).toEqual([{ browser: 'chromium' }]);
    expect(project.test.browser.screenshotFailures).toBe(true);
  });

  it('respects explicit browser project overrides', () => {
    const project = createBrowserProject({
      headless: false,
      isCI: true,
      launchArgs: ['--custom-browser-arg'],
      testPattern: 'src/**/*.browser.test.ts',
      trace: 'on-first-retry',
      traceOutputDir: '.trace-output',
    });

    expect(project.test.include).toEqual(['src/**/*.browser.test.ts']);
    expect(project.test.outputDir).toBe('.trace-output');
    expect(project.test.browser.headless).toBe(false);
    expect(project.test.browser.trace).toBe('on-first-retry');
    expect(project.test.browser.provider).toBeDefined();
  });

  it('defaults trace mode to retain-on-failure when CI is true', () => {
    const project = createBrowserProject({ isCI: true });
    expect(project.test.browser.trace).toBe('retain-on-failure');
  });

  it('uses CI defaults when inferred from environment', () => {
    Reflect.deleteProperty(process.env, 'CI');
    process.env['GITHUB_ACTIONS'] = 'true';

    const project = createBrowserProject();
    expect(project.test.browser.trace).toBe('retain-on-failure');
  });

  it('re-exports playwright provider', () => {
    expect(playwright).toBe(playwrightProvider);
  });
});

describe('boundTraceChunkName', () => {
  it('returns names within the limit unchanged', () => {
    const name = 'short-test-name-0-0';
    expect(boundTraceChunkName(name)).toBe(name);
  });

  it('bounds long names to the limit with a stable hash suffix', () => {
    const name = 'a'.repeat(400);
    const bounded = boundTraceChunkName(name);

    expect(bounded).toHaveLength(MAX_TRACE_CHUNK_NAME_LENGTH);
    expect(bounded.startsWith(name.slice(0, 40))).toBe(true);
    expect(boundTraceChunkName(name)).toBe(bounded);
  });

  it('keeps names distinct when they differ only beyond the truncation point', () => {
    const prefix = 'b'.repeat(300);
    const firstAttempt = boundTraceChunkName(`${prefix}-0-0`);
    const retryAttempt = boundTraceChunkName(`${prefix}-0-1`);

    expect(firstAttempt).not.toBe(retryAttempt);
  });

  it('keeps the attachment destination basename within the 255-byte filesystem limit for the observed CI failure', () => {
    // The exact test name that broke CI run 31192787928 (PR #2296): the
    // attachment destination is the sanitized relative trace path plus a
    // 40-char sha1 and the extension, mirroring vitest's resolveTestAttachment.
    const observedChunkName =
      'follow-up-queue-dispatch-keeps-stick-to-bottom-pinned--BST-1039--queue-flush-at-run-end-does-not-unpin-a-bottom-pinned-thread-0-0';
    const destinationBasename = (chunkName: string): string => {
      const tracePath = `src/__tests__/__traces__/follow-up-queue-repin.browser.test.tsx/browser--chromium--${chunkName}.trace.zip`;
      const sanitized = tracePath.replace(/[^a-z0-9]/gi, '-');
      const hash = createHash('sha1').update(tracePath).digest('hex');
      return `${sanitized}-${hash}.zip`;
    };

    expect(destinationBasename(observedChunkName).length).toBeGreaterThan(255);
    expect(destinationBasename(boundTraceChunkName(observedChunkName)).length).toBeLessThanOrEqual(
      255
    );
  });
});

describe('bindTraceChunkNameBounding', () => {
  const TRACE_COMMANDS = ['__vitest_startChunkTrace', '__vitest_stopChunkTrace'] as const;

  const createFakeBrowser = () => {
    const commands: Record<string, TraceChunkCommand | undefined> = {
      __vitest_startChunkTrace: vi.fn(),
      __vitest_stopChunkTrace: vi.fn(),
    };
    return {
      commands,
      registerCommand: (name: string, cb: TraceChunkCommand) => {
        commands[name] = cb;
      },
    };
  };

  it('bounds the name passed to both trace chunk commands', () => {
    const browser = createFakeBrowser();
    const originals = {
      start: browser.commands['__vitest_startChunkTrace'],
      stop: browser.commands['__vitest_stopChunkTrace'],
    };
    bindTraceChunkNameBounding(browser);

    const context = { sessionId: 'session-1' };
    const longName = 'c'.repeat(400);
    browser.commands['__vitest_startChunkTrace']?.(context, {
      name: longName,
      title: 'my test title',
    });
    browser.commands['__vitest_stopChunkTrace']?.(context, { name: longName });

    expect(originals.start).toHaveBeenCalledWith(context, {
      name: boundTraceChunkName(longName),
      title: 'my test title',
    });
    expect(originals.stop).toHaveBeenCalledWith(context, {
      name: boundTraceChunkName(longName),
    });
  });

  it('throws when a trace chunk command is missing', () => {
    const browser = createFakeBrowser();
    browser.commands['__vitest_stopChunkTrace'] = undefined;

    expect(() => bindTraceChunkNameBounding(browser)).toThrowError(/__vitest_stopChunkTrace/);
  });

  it('does not double-wrap when applied twice', () => {
    const browser = createFakeBrowser();
    bindTraceChunkNameBounding(browser);
    const wrapped = { ...browser.commands };

    bindTraceChunkNameBounding(browser);

    for (const command of TRACE_COMMANDS) {
      expect(browser.commands[command]).toBe(wrapped[command]);
    }
  });
});

describe('createBrowserProject trace name bounding', () => {
  it('re-registers the trace chunk commands when the provider is instantiated', () => {
    const registrations = new Map<string, TraceChunkCommand[]>();
    const commands: Record<string, TraceChunkCommand | undefined> = {};
    const fakeBrowser = {
      commands,
      registerCommand: (name: string, cb: TraceChunkCommand) => {
        commands[name] = cb;
        registrations.set(name, [...(registrations.get(name) ?? []), cb]);
      },
    };
    const fakeProject = {
      browser: fakeBrowser,
      config: { browser: { name: 'chromium' } },
    };

    const project = createBrowserProject({ isCI: true });
    const provider = project.test.browser.provider.providerFactory(fakeProject as never);

    expect(provider).toBeDefined();
    for (const command of ['__vitest_startChunkTrace', '__vitest_stopChunkTrace']) {
      const history = registrations.get(command);
      // First registration comes from the playwright provider constructor,
      // the second is the repo-owned name-bounding wrapper.
      expect(history).toHaveLength(2);
      expect(history?.[0]).not.toBe(history?.[1]);
      expect(commands[command]).toBe(history?.[1]);
    }
  });
});
