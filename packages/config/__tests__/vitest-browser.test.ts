import { createHash } from 'node:crypto';
import { playwright as playwrightProvider } from '@vitest/browser-playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserProjectConfig,
  bindTraceChunkNameBounding,
  boundTraceChunkName,
  createBrowserProject,
  createPlaywrightOptions,
  MAX_TRACE_CHUNK_NAME_BYTES,
  playwright,
  resolveVisualBaselinePath,
  type TraceChunkCommand,
} from '../src/vitest-browser';

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * The setup-file list every browser project must now own (BST-1299). Passed
 * explicitly at each call site because `setupFiles` is required: the factory
 * deliberately has no default for a consumer's `...browserProject.test` spread
 * to drop silently.
 */
const SETUP_FILES = ['@brainstrike/test-utils/vitest.browser.setup'];

const ENV_KEYS = ['CI', 'DEBUG', 'GITHUB_ACTIONS', 'TEST_TIMEOUT_MULTIPLIER'] as const;
const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  CI: process.env['CI'],
  DEBUG: process.env['DEBUG'],
  GITHUB_ACTIONS: process.env['GITHUB_ACTIONS'],
  TEST_TIMEOUT_MULTIPLIER: process.env['TEST_TIMEOUT_MULTIPLIER'],
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
      asyncUtilTimeout: 1000,
      isCI: false,
      setupFiles: SETUP_FILES,
    });

    expect(project.test.name).toBe('browser');
    expect(project.test.include).toEqual(['**/*.browser.test.{ts,tsx}']);
    expect(project.test.browser.enabled).toBe(true);
    expect(project.test.browser.headless).toBe(true);
    expect(project.test.browser.trace).toBe('off');
    expect(project.test.browser.instances).toEqual([{ browser: 'chromium' }]);
    expect(project.test.browser.screenshotFailures).toBe(true);
    expect(project.test.browser.expect.toMatchScreenshot.resolveScreenshotPath).toBe(
      resolveVisualBaselinePath
    );
  });

  it('keeps visual baselines outside the ignored failure-screenshot directory', () => {
    expect(
      resolveVisualBaselinePath({
        arg: 'renders-the-panel-1',
        browserName: 'chromium',
        ext: '.png',
        platform: 'darwin',
        root: '/repo/packages/assistant-ui',
        testFileDirectory: 'src/__tests__',
        testFileName: 'assistant-panel.browser.test.tsx',
      })
    ).toBe(
      '/repo/packages/assistant-ui/src/__tests__/__image_snapshots__/assistant-panel.browser.test.tsx/renders-the-panel-1-chromium-darwin.png'
    );
  });

  it('respects explicit browser project overrides', () => {
    const project = createBrowserProject({
      asyncUtilTimeout: 1000,
      headless: false,
      isCI: true,
      launchArgs: ['--custom-browser-arg'],
      setupFiles: SETUP_FILES,
      testPattern: 'src/**/*.browser.test.ts',
      trace: 'on-first-retry',
      traceOutputDir: '.trace-output',
    });

    expect(project.test.include).toEqual(['src/**/*.browser.test.ts']);
    expect(project.test.browser.headless).toBe(false);
    expect(project.test.browser.trace).toEqual({
      mode: 'on-first-retry',
      tracesDir: '.trace-output',
    });
    expect(project.test.browser.provider).toBeDefined();
  });

  it('defaults trace mode to retain-on-failure when CI is true', () => {
    const project = createBrowserProject({
      asyncUtilTimeout: 1000,
      isCI: true,
      setupFiles: SETUP_FILES,
    });
    expect(project.test.browser.trace).toEqual({
      mode: 'retain-on-failure',
      tracesDir: 'test-results',
    });
  });

  it('uses CI defaults when inferred from environment', () => {
    Reflect.deleteProperty(process.env, 'CI');
    process.env['GITHUB_ACTIONS'] = 'true';

    const project = createBrowserProject({ asyncUtilTimeout: 1000, setupFiles: SETUP_FILES });
    expect(project.test.browser.trace).toEqual({
      mode: 'retain-on-failure',
      tracesDir: 'test-results',
    });
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

    expect(bounded).toHaveLength(MAX_TRACE_CHUNK_NAME_BYTES);
    expect(bounded.startsWith(name.slice(0, 40))).toBe(true);
    expect(boundTraceChunkName(name)).toBe(bounded);
  });

  it('keeps names distinct when they differ only beyond the truncation point', () => {
    const prefix = 'b'.repeat(300);
    const firstAttempt = boundTraceChunkName(`${prefix}-0-0`);
    const retryAttempt = boundTraceChunkName(`${prefix}-0-1`);

    expect(firstAttempt).not.toBe(retryAttempt);
  });

  it('bounds by encoded bytes rather than UTF-16 code units', () => {
    // 80 CJK characters are within the limit by `.length` but are 240 bytes on
    // disk. Vitest's own sanitizer makes this unreachable today; the bound is
    // still expressed in the unit the filesystem actually enforces.
    const bounded = boundTraceChunkName('描'.repeat(80));

    expect(byteLength(bounded)).toBeLessThanOrEqual(MAX_TRACE_CHUNK_NAME_BYTES);
  });

  it('never truncates through a code point', () => {
    // A 4-byte astral code point straddling the cut must be dropped whole,
    // not split into a lone surrogate.
    const bounded = boundTraceChunkName('😀'.repeat(60));

    expect(byteLength(bounded)).toBeLessThanOrEqual(MAX_TRACE_CHUNK_NAME_BYTES);
    // A lone surrogate would round-trip through UTF-8 as U+FFFD.
    const roundTripped = new TextDecoder().decode(new TextEncoder().encode(bounded));
    expect(roundTripped).toBe(bounded);
    expect(bounded).not.toContain('�');
  });

  it('keeps the attachment destination basename within the 255-byte filesystem limit for the observed CI failure', () => {
    // The exact test name that broke CI run 31192787928 (PR #2296). The model
    // below mirrors vitest's resolveTestAttachment + sanitizeFilePath and
    // reproduces the destination in that CI log byte for byte (259).
    const observedChunkName =
      'follow-up-queue-dispatch-keeps-stick-to-bottom-pinned--BST-1039--queue-flush-at-run-end-does-not-unpin-a-bottom-pinned-thread-0-0';
    const destinationBasename = (chunkName: string): string => {
      const tracePath = `src/__tests__/__traces__/follow-up-queue-repin.browser.test.tsx/browser--chromium--${chunkName}.trace.zip`;
      // vitest's sanitizeFilePath collapses runs of special characters.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors vitest verbatim
      const sanitized = tracePath.replace(/[\x00-\x2C\x2E\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g, '-');
      const hash = createHash('sha1').update(tracePath).digest('hex');
      return `${sanitized}-${hash}.zip`;
    };

    expect(byteLength(destinationBasename(observedChunkName))).toBe(259);
    expect(
      byteLength(destinationBasename(boundTraceChunkName(observedChunkName)))
    ).toBeLessThanOrEqual(255);
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

    const project = createBrowserProject({
      asyncUtilTimeout: 1000,
      isCI: true,
      setupFiles: SETUP_FILES,
    });
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

describe('createBrowserProject async-utility timeout wiring (BST-1299)', () => {
  it('loads exactly the setup files the caller owns', () => {
    // The shared Node setup imports node:buffer and cannot run in a page, so
    // before BST-1299 the browser lane had no setup file at all — and therefore
    // no way to call @testing-library/dom's configure(), the library's only
    // entry point for asyncUtilTimeout.
    //
    // The list passes through verbatim: @brainstrike/config is `tooling` and
    // does not depend on @brainstrike/test-utils, so that specifier is the
    // caller's to write — the same boundary that makes asyncUtilTimeout
    // caller-resolved.
    const setupFiles = [...SETUP_FILES, './extra-setup.ts'];

    expect(createBrowserProject({ asyncUtilTimeout: 1000, setupFiles }).test.setupFiles).toEqual(
      setupFiles
    );
  });

  it('copies the list so a consumer appending to it cannot mutate the caller', () => {
    const setupFiles = [...SETUP_FILES];
    const project = createBrowserProject({ asyncUtilTimeout: 1000, setupFiles });

    project.test.setupFiles.push('./late-addition.ts');

    expect(setupFiles).toEqual(SETUP_FILES);
  });

  it.each([
    ['a missing list', undefined],
    ['a bare specifier', '@brainstrike/test-utils/vitest.browser.setup'],
    ['an empty specifier', ['']],
    ['a non-string entry', [42]],
  ])('refuses %s instead of substituting a default', (_label, setupFiles) => {
    // No default exists to substitute, deliberately: a factory-supplied entry
    // would be dropped without a word by a consumer writing
    // `{ ...browserProject.test, setupFiles: ['./mine.ts'] }`, putting the lane
    // back on the unscalable 1s budget — the BST-1299 defect reintroduced.
    expect(() =>
      createBrowserProject({
        asyncUtilTimeout: 1000,
        setupFiles,
      } as unknown as BrowserProjectConfig)
    ).toThrow(TypeError);
  });

  it('refuses an empty setup-file list', () => {
    // asyncUtilTimeout can only be applied from inside the page, so a browser
    // project with no setup file at all is unscalable by construction.
    expect(() => createBrowserProject({ asyncUtilTimeout: 1000, setupFiles: [] })).toThrow(
      RangeError
    );
  });

  it('publishes the caller-resolved budget over test.provide', () => {
    // Verbatim: the caller has already applied TEST_TIMEOUT_MULTIPLIER, and
    // re-deriving or clamping it here would make the knob a suggestion.
    expect(
      createBrowserProject({ asyncUtilTimeout: 2000, setupFiles: SETUP_FILES }).test.provide
    ).toEqual({
      asyncUtilTimeout: 2000,
    });
  });

  it('derives the project test timeout from the budget it was given', () => {
    // 1000 x 5 = 5000 reproduces Vitest's default exactly, so an unscaled lane
    // behaves as it did before this wiring existed.
    expect(
      createBrowserProject({ asyncUtilTimeout: 1000, setupFiles: SETUP_FILES }).test.testTimeout
    ).toBe(5000);
    expect(
      createBrowserProject({ asyncUtilTimeout: 2000, setupFiles: SETUP_FILES }).test.testTimeout
    ).toBe(10_000);
  });

  it('keeps asyncUtilTimeout under testTimeout for every budget', () => {
    // Otherwise Vitest's timeout fires first and swallows waitFor's report of
    // the last assertion that failed.
    for (const asyncUtilTimeout of [500, 1000, 2000, 5000, 10_000]) {
      const project = createBrowserProject({ asyncUtilTimeout, setupFiles: SETUP_FILES }).test;
      expect(project.provide.asyncUtilTimeout).toBeLessThan(project.testTimeout);
    }
  });

  it('keeps the wiring inside `test`, where consumers spread it', () => {
    // ui / assistant-ui / embedding-worker all spread `...browserProject.test`
    // into their own project object; anything published beside `test` would be
    // dropped without a word.
    const spreadByConsumers = {
      ...createBrowserProject({ asyncUtilTimeout: 1000, setupFiles: SETUP_FILES }).test,
    };

    expect(spreadByConsumers.provide).toEqual({ asyncUtilTimeout: 1000 });
    expect(spreadByConsumers.setupFiles).toEqual(SETUP_FILES);
    expect(spreadByConsumers.testTimeout).toBe(5000);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the unusable budget %p instead of substituting a default',
    (asyncUtilTimeout) => {
      expect(() => createBrowserProject({ asyncUtilTimeout, setupFiles: SETUP_FILES })).toThrow(
        RangeError
      );
    }
  );
});
