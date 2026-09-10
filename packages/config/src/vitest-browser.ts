/**
 * Shared Vitest 5 Browser Mode configuration utilities
 * Used for packages requiring real browser APIs (WASM, IndexedDB, localStorage)
 *
 * @see https://vitest.dev/guide/browser/
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
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

export interface BrowserProjectConfig extends BrowserTestConfig {
  /**
   * @testing-library/dom's async-utility budget (`waitFor`, `findBy*`) in
   * milliseconds, ALREADY scaled for the environment — pass
   * `getAsyncUtilTimeout()` from @brainstrike/test-utils.
   *
   * Required, and resolved by the caller rather than here, for two reasons.
   * The architectural one: @brainstrike/config is `tooling`, which may depend
   * on nothing (architecture/domain-map.json), so it cannot read
   * @brainstrike/test-utils' TEST_TIMEOUT_MULTIPLIER semantics — and
   * re-deriving them here would be the duplicate-source-of-truth this wiring
   * exists to remove. The practical one: `process` does not exist inside the
   * browser page, so SOMETHING running in Node has to resolve the number and
   * hand it over; making the parameter required means a new browser project
   * cannot quietly inherit an unscalable default the way every one of them did
   * before BST-1299.
   */
  asyncUtilTimeout: number;
  /**
   * Vitest setup files for the browser project. MUST include a setup file that
   * applies `asyncUtilTimeout` inside the page — in this repo that is
   * '@brainstrike/test-utils/vitest.browser.setup'.
   *
   * Caller-resolved for the same boundary reason as `asyncUtilTimeout`: a
   * hard-coded '@brainstrike/test-utils/…' string here would be a real
   * dependency from `tooling` onto a workspace package, merely invisible to
   * the domain-boundary contract because it is not an `import`.
   * @brainstrike/config does not declare that package, and a future browser
   * project whose own manifest does not either would fail to resolve a
   * specifier it never wrote.
   *
   * Required, never defaulted, and never merged with a hidden entry: consumers
   * spread `...browserProject.test` into their own project object, so a
   * factory-supplied default could be silently dropped by a later `setupFiles`
   * key — reinstating the unscalable 1s budget without a word. Owning the whole
   * list means a caller can only lose the wiring by deleting its own argument;
   * the per-lane timing proof (`async-util-timeout-wiring.browser.test.ts`) is
   * what catches it if they do.
   */
  setupFiles: readonly string[];
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

interface VisualBaselinePathData {
  arg: string;
  browserName: string;
  ext: string;
  platform: NodeJS.Platform;
  root: string;
  testFileDirectory: string;
  testFileName: string;
}

/**
 * Keeps intentional `toMatchScreenshot` references separate from Vitest's
 * generated failure captures, which remain under the ignored `.vitest/attachments/failure-screenshots`.
 */
export function resolveVisualBaselinePath(data: VisualBaselinePathData): string {
  return path.join(
    data.root,
    data.testFileDirectory,
    '__image_snapshots__',
    data.testFileName,
    `${data.arg}-${data.browserName}-${data.platform}${data.ext}`
  );
}

/**
 * Vitest builds the Playwright trace chunk name from the full sanitized test
 * name, unbounded, and later copies the trace into `.vitest/attachments` as
 * `<sanitized package-relative trace path>-<40-char sha1>.zip`. Long
 * describe/test names push that basename past the 255-byte filesystem limit,
 * so the copy dies with ENAMETOOLONG and masks the real test failure
 * (https://github.com/vitest-dev/vitest/issues/9168, unfixed as of 4.1.10).
 *
 * The real invariant is a budget on the DIRECTORY PREFIX, not on the chunk
 * name. The attachment basename is
 *
 *   sanitize(`<dir>/__traces__/<testfile>/<project>-`) + <chunk name>
 *     + `-trace-zip` (10) + `-` (1) + sha1 (40) + `.zip` (4)
 *
 * so 255 bytes allows `chunk + prefix <= 200`. At 80 bytes of chunk name the
 * sanitized prefix must stay under 120 bytes; the repo's deepest browser test
 * today (assistant-ui's assistant-thread-virtualization) sits at 85, i.e. 220
 * bytes total with 35 to spare. A longer test filename or a deeper directory
 * eats that headroom, so the budget is enforced against the real tree by
 * scripts/__tests__/browser-trace-name-budget.test.mjs rather than trusted.
 */
export const MAX_TRACE_CHUNK_NAME_BYTES = 80;

const utf8 = new TextEncoder();

const byteLength = (value: string): number => utf8.encode(value).length;

/** Truncates on a code-point boundary so a bounded name is never mojibake. */
function truncateToBytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let truncated = '';
  for (const codePoint of value) {
    const size = byteLength(codePoint);
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    truncated += codePoint;
  }
  return truncated;
}

/**
 * Bounded in BYTES, not UTF-16 code units. Vitest's `getTraceName` sanitizes
 * with `/[^a-z0-9]/gi` (which drops every non-ASCII code unit, including the
 * `i`-flag folding traps U+212A and U+017F), so today's input is always ASCII
 * and the two measures agree — but the limit this protects is a filesystem
 * byte limit, and depending on an upstream regex to keep it that way is the
 * same class of silent coupling this whole module exists to remove.
 */
export function boundTraceChunkName(name: string): string {
  if (byteLength(name) <= MAX_TRACE_CHUNK_NAME_BYTES) {
    return name;
  }
  // The truncated tail carries the retry/repeat counters, so a hash of the
  // full name keeps bounded names unique across retries.
  const digest = createHash('sha1').update(name).digest('hex').slice(0, 10);
  const prefix = truncateToBytes(name, MAX_TRACE_CHUNK_NAME_BYTES - digest.length - 1);
  return `${prefix}-${digest}`;
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
 * downstream, the `.vitest/attachments` copy destination.
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

/**
 * Wraps a playwright provider definition so its trace chunk names are bounded.
 * `createBrowserProject` applies this for you — call it directly only from a
 * browser project that builds its own `playwright()` provider (packages/db and
 * packages/storage), otherwise that project keeps the ENAMETOOLONG exposure.
 *
 * Assumes the provider definition is a plain object: the spread below copies
 * own enumerable properties only, so a future class instance or accessor on
 * the definition would be dropped silently.
 */
export function withBoundedTraceChunkNames(
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
 * Creates Playwright provider options for Vitest 5 Browser Mode
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
 * How many failing `waitFor` budgets fit inside one browser test's timeout.
 *
 * The browser project previously declared NO timeout at all, so it ran on
 * Vitest's 5s default while @testing-library/dom ran on its own 1s default —
 * the same 5:1 relationship, arrived at by coincidence. Deriving `testTimeout`
 * from the (already scaled) async-utility budget makes that relationship
 * deliberate and multiplier-proof: at a multiplier of 1 the project still gets
 * exactly 5000ms, and at every other setting the two move together.
 *
 * The ratio matters because if `asyncUtilTimeout` ever caught up with
 * `testTimeout`, Vitest's timeout would fire first and replace
 * @testing-library's "here is the last assertion that failed" report with a
 * bare "test timed out" — strictly worse to debug.
 */
const TEST_TIMEOUT_PER_ASYNC_UTIL_BUDGET = 5;

/**
 * Validates the caller-owned setup-file list and returns a mutable copy, so a
 * consumer that appends to `browserProject.test.setupFiles` cannot mutate the
 * array it passed in.
 *
 * An empty list is rejected rather than accepted as "this lane wants none":
 * the async-utility budget can only be applied from a setup file, so a browser
 * project without one is by construction back on @testing-library/dom's
 * unscalable 1s default — the BST-1299 defect.
 */
function resolveSetupFiles(setupFiles: readonly string[]): string[] {
  if (
    !(Array.isArray(setupFiles) && setupFiles.every((file) => typeof file === 'string' && file))
  ) {
    throw new TypeError(
      `createBrowserProject requires setupFiles to be an array of non-empty specifiers, received ${JSON.stringify(setupFiles)}. Pass ['@brainstrike/test-utils/vitest.browser.setup'].`
    );
  }
  if (setupFiles.length === 0) {
    throw new RangeError(
      "createBrowserProject requires at least one setup file: asyncUtilTimeout can only be applied from inside the page, so a browser project with no setup file silently keeps @testing-library/dom's 1s default. Pass ['@brainstrike/test-utils/vitest.browser.setup']."
    );
  }
  return [...setupFiles];
}

/**
 * Creates a browser test project configuration for Vitest 5
 *
 * @example
 * ```ts
 * import { getAsyncUtilTimeout } from '@brainstrike/test-utils/test-timeouts';
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
 *       createBrowserProject({
 *         asyncUtilTimeout: getAsyncUtilTimeout(),
 *         setupFiles: ['@brainstrike/test-utils/vitest.browser.setup'],
 *       }),
 *     ],
 *   },
 * });
 * ```
 */
export function createBrowserProject(config: BrowserProjectConfig) {
  const testPattern = config.testPattern ?? '**/*.browser.test.{ts,tsx}';
  const headless = config.headless ?? true;
  const isCI = resolveIsCI(config);

  // Enable traces on failure in CI by default for debugging
  const trace = config.trace ?? (isCI ? 'retain-on-failure' : 'off');
  const traceOutputDir = config.traceOutputDir ?? 'test-results';

  const { asyncUtilTimeout } = config;
  if (!(Number.isFinite(asyncUtilTimeout) && asyncUtilTimeout > 0)) {
    throw new RangeError(
      `createBrowserProject requires a positive asyncUtilTimeout in milliseconds, received ${JSON.stringify(asyncUtilTimeout)}. Pass getAsyncUtilTimeout() from @brainstrike/test-utils.`
    );
  }
  const setupFiles = resolveSetupFiles(config.setupFiles);

  return {
    test: {
      browser: {
        enabled: true,
        expect: {
          toMatchScreenshot: {
            resolveScreenshotPath: resolveVisualBaselinePath,
          },
        },
        headless,
        instances: [{ browser: 'chromium' as const }],
        provider: withBoundedTraceChunkNames(playwright(createPlaywrightOptions(config))),
        // Capture screenshots on failure for quick visual debugging
        screenshotFailures: true,
        // Playwright trace configuration
        // Generates .zip trace files viewable with `npx playwright show-trace <file>`
        trace: trace === 'off' ? ('off' as const) : { mode: trace, tracesDir: traceOutputDir },
      },
      include: [testPattern],
      name: 'browser',
      // TEST_TIMEOUT_MULTIPLIER's only route into the browser page (BST-1299).
      // `process` does not exist there, so the caller resolves the budget in
      // Node and it travels over `provide`; the setup file below `inject`s it
      // into @testing-library/dom, whose async utilities otherwise sit on an
      // unscalable 1s default no matter what the lane sets.
      //
      // All three fields live inside `test` on purpose: every consumer spreads
      // `...browserProject.test` into its own project object, so anything
      // published beside `test` (a Vite-level `define`, say) would be dropped
      // without a word.
      provide: { asyncUtilTimeout },
      setupFiles,
      testTimeout: asyncUtilTimeout * TEST_TIMEOUT_PER_ASYNC_UTIL_BUDGET,
    },
  };
}

export type { PlaywrightProviderOptions };
/**
 * Re-export playwright provider for direct use
 */
export { playwright };
