/**
 * Shared Vitest 4 Browser Mode configuration utilities
 * Used for packages requiring real browser APIs (WASM, IndexedDB, localStorage)
 *
 * @see https://vitest.dev/guide/browser/
 */

import { createHash } from 'node:crypto';
import type { PlaywrightProviderOptions } from '@vitest/browser-playwright';
import { playwright } from '@vitest/browser-playwright';

export interface BrowserTestConfig {
  /** Headless mode (default: true) */
  headless?: boolean;
  /** Whether running in CI environment */
  isCI?: boolean;
  /** Playwright launch args for the browser */
  launchArgs?: string[];
  /** Test file pattern for browser tests (default: '**\/*.browser.test.{ts,tsx}') */
  testPattern?: string;
  /**
   * Playwright trace mode for debugging failed tests
   * - 'off': No traces (default for local dev)
   * - 'on': Always generate traces (performance impact)
   * - 'on-first-retry': Capture traces only when test is retried first time
   * - 'on-all-retries': Capture traces on every retry
   * - 'retain-on-failure': Keep traces only for failed tests (recommended for CI)
   * @see https://vitest.dev/config/browser/trace
   */
  trace?: 'off' | 'on' | 'on-first-retry' | 'on-all-retries' | 'retain-on-failure';
  /** Directory for trace output (default: 'test-results') */
  traceOutputDir?: string;
}

/**
 * Default CI launch arguments for browser stability
 */
const CI_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-setuid-sandbox',
  '--disable-features=VizDisplayCompositor',
];

const resolveIsCI = (config?: BrowserTestConfig): boolean =>
  config?.isCI ?? Boolean(process.env['CI'] || process.env['GITHUB_ACTIONS']);

/**
 * Vitest builds the Playwright trace chunk name from the full sanitized test
 * name, unbounded, and later copies the trace into `.vitest-attachments` as
 * `<sanitized relative trace path>-<40-char sha1>.zip`. Long describe/test
 * names push that basename past the 255-byte filesystem limit, so the copy
 * dies with ENAMETOOLONG and masks the real test failure
 * (https://github.com/vitest-dev/vitest/issues/9168, unfixed as of 4.1.10).
 *
 * 80 chars leaves ~120 bytes of headroom in the attachment basename for the
 * repo's test-directory prefixes after the hash and extension are added.
 */
export const MAX_TRACE_CHUNK_NAME_LENGTH = 80;

export function boundTraceChunkName(name: string): string {
  if (name.length <= MAX_TRACE_CHUNK_NAME_LENGTH) {
    return name;
  }
  // The truncated tail carries the retry/repeat counters, so a hash of the
  // full name keeps bounded names unique across retries.
  const digest = createHash('sha1').update(name).digest('hex').slice(0, 10);
  return `${name.slice(0, MAX_TRACE_CHUNK_NAME_LENGTH - digest.length - 1)}-${digest}`;
}

export type TraceChunkCommand = (
  context: unknown,
  payload: { name: string } & Record<string, unknown>
) => unknown;

interface TraceChunkCommandRegistry {
  commands: Record<string, TraceChunkCommand | undefined>;
  registerCommand: (name: string, cb: TraceChunkCommand) => void;
}

const TRACE_CHUNK_COMMANDS = ['__vitest_startChunkTrace', '__vitest_stopChunkTrace'] as const;

const boundedTraceChunkCommands = new WeakSet<TraceChunkCommand>();

/**
 * Both trace chunk commands resolve the trace zip path deterministically from
 * the chunk `name`, so bounding the name here bounds the trace filename and,
 * downstream, the `.vitest-attachments` copy destination.
 */
export function bindTraceChunkNameBounding(browser: TraceChunkCommandRegistry): void {
  for (const command of TRACE_CHUNK_COMMANDS) {
    const original = browser.commands[command];
    if (!original) {
      throw new Error(
        `Expected the playwright provider to register "${command}" — vitest internals changed; update bindTraceChunkNameBounding in @brainstrike/config.`
      );
    }
    if (boundedTraceChunkCommands.has(original)) {
      continue;
    }
    const bounded: TraceChunkCommand = (context, payload) =>
      original(context, { ...payload, name: boundTraceChunkName(payload.name) });
    boundedTraceChunkCommands.add(bounded);
    browser.registerCommand(command, bounded);
  }
}

type PlaywrightProviderDefinition = ReturnType<typeof playwright>;

function withBoundedTraceChunkNames(
  definition: PlaywrightProviderDefinition
): PlaywrightProviderDefinition {
  return {
    ...definition,
    providerFactory(project) {
      // The provider constructor registers its commands on project.browser
      // before this returns, so the bounding wrappers can be layered on top.
      const provider = definition.providerFactory(project);
      const browser = project.browser as unknown as TraceChunkCommandRegistry | undefined;
      if (!browser) {
        throw new Error(
          'Expected project.browser to exist when the playwright provider is instantiated — vitest internals changed; update withBoundedTraceChunkNames in @brainstrike/config.'
        );
      }
      bindTraceChunkNameBounding(browser);
      return provider;
    },
  };
}

/**
 * Creates Playwright provider options for Vitest 4 Browser Mode
 */
export function createPlaywrightOptions(config?: BrowserTestConfig): PlaywrightProviderOptions {
  const isCI = resolveIsCI(config);
  const launchArgs = config?.launchArgs ?? (isCI ? CI_LAUNCH_ARGS : []);

  // Only include launchOptions if there are args to pass
  if (launchArgs.length > 0) {
    return {
      launchOptions: {
        args: launchArgs,
      },
    };
  }

  return {};
}

/**
 * Creates a browser test project configuration for Vitest 4
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vitest/config';
 * import { createBrowserProject } from '@brainstrike/config/vitest-browser';
 *
 * export default defineConfig({
 *   test: {
 *     projects: [
 *       { // Unit tests with jsdom
 *         test: {
 *           name: 'unit',
 *           environment: 'jsdom',
 *           include: ['**\/*.test.ts'],
 *         },
 *       },
 *       createBrowserProject(), // Browser tests
 *     ],
 *   },
 * });
 * ```
 */
export function createBrowserProject(config?: BrowserTestConfig) {
  const testPattern = config?.testPattern ?? '**/*.browser.test.{ts,tsx}';
  const headless = config?.headless ?? true;
  const isCI = resolveIsCI(config);

  // Enable traces on failure in CI by default for debugging
  const trace = config?.trace ?? (isCI ? 'retain-on-failure' : 'off');
  const traceOutputDir = config?.traceOutputDir ?? 'test-results';

  return {
    test: {
      browser: {
        enabled: true,
        headless,
        instances: [{ browser: 'chromium' as const }],
        provider: withBoundedTraceChunkNames(playwright(createPlaywrightOptions(config))),
        // Capture screenshots on failure for quick visual debugging
        screenshotFailures: true,
        // Playwright trace configuration
        // Generates .zip trace files viewable with `npx playwright show-trace <file>`
        trace,
      },
      include: [testPattern],
      name: 'browser',
      // Output directory for traces and screenshots
      outputDir: traceOutputDir,
    },
  };
}

export type { PlaywrightProviderOptions };
/**
 * Re-export playwright provider for direct use
 */
export { playwright };
