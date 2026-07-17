/**
 * Failure Artifact Collector for E2E Tests (BST-180)
 *
 * Captures comprehensive diagnostic information when tests fail:
 * - Console logs (errors, warnings, info)
 * - Network activity summary
 * - Application state
 * - DOM snapshot
 *
 * This data helps debug flaky tests and CI failures without needing
 * to reproduce the issue locally.
 */

import type { Page, TestInfo } from '@playwright/test';

/**
 * Console message entry with structured data
 */
export interface ConsoleLogEntry {
  location?: string;
  text: string;
  timestamp: number;
  type: 'error' | 'warning' | 'log' | 'info' | 'debug';
}

/**
 * Network request summary for debugging
 */
export interface NetworkRequestEntry {
  failed: boolean;
  failureReason?: string | undefined;
  method: string;
  status: number | null;
  timing: number | null;
  url: string;
}

/**
 * Application state snapshot
 */
export interface AppStateSnapshot {
  localStorage: Record<string, string>;
  timestamp: number;
  title: string;
  url: string;
  viewportSize: { width: number; height: number } | null;
}

/**
 * Complete failure diagnostic bundle
 */
export interface FailureDiagnostics {
  appState: AppStateSnapshot | null;
  consoleLogs: ConsoleLogEntry[];
  domSnapshot?: string | undefined;
  duration: number;
  error?: string | undefined;
  networkRequests: NetworkRequestEntry[];
  retryCount: number;
  stack?: string | undefined;
  testFile: string;
  testName: string;
  timestamp: string;
}

/**
 * Type-safe console message type mapping
 */
const CONSOLE_TYPE_MAP: Record<string, ConsoleLogEntry['type']> = {
  debug: 'debug',
  error: 'error',
  info: 'info',
  warning: 'warning',
};

/**
 * Collector that accumulates diagnostics during test execution
 */
export class FailureArtifactCollector {
  private consoleLogs: ConsoleLogEntry[] = [];
  private networkRequests: NetworkRequestEntry[] = [];
  private isAttached = false;

  // Store listener references for proper cleanup (prevents memory leaks)
  private consoleListener?: ((msg: import('@playwright/test').ConsoleMessage) => void) | undefined;
  private pageErrorListener?: ((error: Error) => void) | undefined;
  private requestFinishedListener?:
    | ((request: import('@playwright/test').Request) => void)
    | undefined;
  private requestFailedListener?:
    | ((request: import('@playwright/test').Request) => void)
    | undefined;

  constructor(private readonly page: Page) {}

  /**
   * Start collecting diagnostics. Call this at the beginning of each test.
   */
  attach(): void {
    if (this.isAttached) {
      return;
    }

    this.consoleLogs = [];
    this.networkRequests = [];

    // Define console listener with type-safe mapping
    this.consoleListener = (msg) => {
      const msgType = msg.type();
      const type = CONSOLE_TYPE_MAP[msgType] ?? 'log';

      this.consoleLogs.push({
        location: msg.location()?.url,
        text: msg.text(),
        timestamp: Date.now(),
        type,
      });
    };
    this.page.on('console', this.consoleListener);

    // Define page error listener
    this.pageErrorListener = (error) => {
      this.consoleLogs.push({
        text: `Page Error: ${error.message}`,
        timestamp: Date.now(),
        type: 'error',
      });
    };
    this.page.on('pageerror', this.pageErrorListener);

    // Define request finished listener (synchronous push, async status update)
    // This fixes the race condition where async handlers complete after test ends
    this.requestFinishedListener = (request) => {
      const entry: NetworkRequestEntry = {
        failed: false,
        method: request.method(),
        status: null, // Will be updated asynchronously
        timing: request.timing().responseEnd,
        url: request.url(),
      };
      this.networkRequests.push(entry);

      // Update status asynchronously without blocking
      request
        .response()
        .then((response) => {
          entry.status = response?.status() ?? null;
        })
        .catch(() => {
          // Response unavailable - mark as potentially failed
          entry.failed = true;
        });
    };
    this.page.on('requestfinished', this.requestFinishedListener);

    // Define request failed listener
    this.requestFailedListener = (request) => {
      this.networkRequests.push({
        failed: true,
        failureReason: request.failure()?.errorText,
        method: request.method(),
        status: null,
        timing: null,
        url: request.url(),
      });
    };
    this.page.on('requestfailed', this.requestFailedListener);

    this.isAttached = true;
  }

  /**
   * Stop collecting and clean up listeners.
   * Explicitly removes all event listeners to prevent memory leaks.
   */
  detach(): void {
    if (!this.isAttached) {
      return;
    }

    // Remove all registered listeners to prevent memory leaks
    if (this.consoleListener) {
      this.page.off('console', this.consoleListener);
      this.consoleListener = undefined;
    }
    if (this.pageErrorListener) {
      this.page.off('pageerror', this.pageErrorListener);
      this.pageErrorListener = undefined;
    }
    if (this.requestFinishedListener) {
      this.page.off('requestfinished', this.requestFinishedListener);
      this.requestFinishedListener = undefined;
    }
    if (this.requestFailedListener) {
      this.page.off('requestfailed', this.requestFailedListener);
      this.requestFailedListener = undefined;
    }

    this.isAttached = false;
  }

  /**
   * Get accumulated console logs
   */
  getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.consoleLogs];
  }

  /**
   * Get console logs filtered by type
   */
  getConsoleErrors(): ConsoleLogEntry[] {
    return this.consoleLogs.filter((log) => log.type === 'error');
  }

  /**
   * Get network requests summary
   */
  getNetworkRequests(): NetworkRequestEntry[] {
    return [...this.networkRequests];
  }

  /**
   * Get failed network requests only
   */
  getFailedRequests(): NetworkRequestEntry[] {
    return this.networkRequests.filter((req) => req.failed || (req.status && req.status >= 400));
  }

  /**
   * Capture current application state
   */
  async captureAppState(): Promise<AppStateSnapshot | null> {
    if (this.page.isClosed()) {
      return null;
    }

    try {
      // Extract synchronous values before Promise.all (no need for Promise.resolve wrapper)
      const url = this.page.url();
      const viewportSize = this.page.viewportSize();

      const [title, localStorage] = await Promise.all([
        this.page.title(),
        this.page.evaluate(() => {
          const storage: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key) {
              storage[key] = window.localStorage.getItem(key) ?? '';
            }
          }
          return storage;
        }),
      ]);

      return {
        localStorage,
        timestamp: Date.now(),
        title,
        url,
        viewportSize,
      };
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Intentional for E2E diagnostic logging
      console.warn('Failed to capture app state:', error);
      return null;
    }
  }

  /**
   * Capture a DOM snapshot (useful for debugging rendering issues)
   */
  async captureDomSnapshot(): Promise<string | undefined> {
    if (this.page.isClosed()) {
      return;
    }

    try {
      return await this.page.content();
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Intentional for E2E diagnostic logging
      console.warn('Failed to capture DOM snapshot:', error);
      return;
    }
  }

  /**
   * Generate complete failure diagnostics bundle
   */
  async generateDiagnostics(testInfo: TestInfo): Promise<FailureDiagnostics> {
    const [appState, domSnapshot] = await Promise.all([
      this.captureAppState(),
      this.captureDomSnapshot(),
    ]);

    const error = testInfo.error;

    return {
      appState,
      consoleLogs: this.getConsoleLogs(),
      domSnapshot,
      duration: testInfo.duration,
      error: error?.message,
      networkRequests: this.getNetworkRequests(),
      retryCount: testInfo.retry,
      stack: error?.stack,
      testFile: testInfo.file,
      testName: testInfo.title,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Attach diagnostics as test artifacts on failure
   */
  async attachDiagnosticsOnFailure(testInfo: TestInfo): Promise<void> {
    if (testInfo.status === 'passed' || testInfo.status === 'skipped') {
      return;
    }

    const diagnostics = await this.generateDiagnostics(testInfo);

    // Attach console logs
    if (diagnostics.consoleLogs.length > 0) {
      const consoleLogContent = diagnostics.consoleLogs
        .map((log) => {
          const ts = new Date(log.timestamp).toISOString();
          const loc = log.location ? ` [${log.location}]` : '';
          return `[${ts}] [${log.type.toUpperCase()}]${loc} ${log.text}`;
        })
        .join('\n');

      await testInfo.attach('console-logs.txt', {
        body: consoleLogContent,
        contentType: 'text/plain',
      });
    }

    // Attach failed network requests
    const failedRequests = diagnostics.networkRequests.filter(
      (req) => req.failed || (req.status && req.status >= 400)
    );
    if (failedRequests.length > 0) {
      await testInfo.attach('failed-network-requests.json', {
        body: JSON.stringify(failedRequests, null, 2),
        contentType: 'application/json',
      });
    }

    // Attach full diagnostics as JSON
    await testInfo.attach('failure-diagnostics.json', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    });

    // Attach app state separately for quick reference
    if (diagnostics.appState) {
      await testInfo.attach('app-state.json', {
        body: JSON.stringify(diagnostics.appState, null, 2),
        contentType: 'application/json',
      });
    }
  }
}

/**
 * Create a failure collector for a page
 */
export function createFailureCollector(page: Page): FailureArtifactCollector {
  const collector = new FailureArtifactCollector(page);
  collector.attach();
  return collector;
}

/**
 * Summary of test health metrics for the entire suite
 */
export interface TestHealthMetrics {
  averageTestDuration: number;
  commonErrors: Array<{ message: string; count: number }>;
  flakyTests: string[];
  totalConsoleErrors: number;
  totalFailedRequests: number;
}

/**
 * Aggregate metrics from multiple test diagnostics
 */
export function aggregateTestMetrics(diagnosticsList: FailureDiagnostics[]): TestHealthMetrics {
  const consoleErrors = diagnosticsList.flatMap((d) =>
    d.consoleLogs.filter((l) => l.type === 'error')
  );
  const failedRequests = diagnosticsList.flatMap((d) =>
    d.networkRequests.filter((r) => r.failed || (r.status && r.status >= 400))
  );

  // Find flaky tests (tests that passed on retry)
  const flakyTests = diagnosticsList.filter((d) => d.retryCount > 0).map((d) => d.testName);

  // Count common error patterns
  const errorCounts = new Map<string, number>();
  for (const diag of diagnosticsList) {
    if (diag.error) {
      const key = diag.error.slice(0, 100); // Truncate for grouping
      errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    }
  }

  const commonErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([message, count]) => ({ count, message }));

  return {
    averageTestDuration:
      diagnosticsList.reduce((sum, d) => sum + d.duration, 0) / diagnosticsList.length || 0,
    commonErrors,
    flakyTests: [...new Set(flakyTests)],
    totalConsoleErrors: consoleErrors.length,
    totalFailedRequests: failedRequests.length,
  };
}
