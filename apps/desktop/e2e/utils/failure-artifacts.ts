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
export type ConsoleLogEntry = {
  type: 'error' | 'warning' | 'log' | 'info' | 'debug';
  text: string;
  timestamp: number;
  location?: string;
};

/**
 * Network request summary for debugging
 */
export type NetworkRequestEntry = {
  url: string;
  method: string;
  status: number | null;
  timing: number | null;
  failed: boolean;
  failureReason?: string;
};

/**
 * Application state snapshot
 */
export type AppStateSnapshot = {
  url: string;
  title: string;
  viewportSize: { width: number; height: number } | null;
  localStorage: Record<string, string>;
  timestamp: number;
};

/**
 * Complete failure diagnostic bundle
 */
export type FailureDiagnostics = {
  testName: string;
  testFile: string;
  timestamp: string;
  duration: number;
  retryCount: number;
  error?: string;
  stack?: string;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: NetworkRequestEntry[];
  appState: AppStateSnapshot | null;
  domSnapshot?: string;
};

/**
 * Collector that accumulates diagnostics during test execution
 */
export class FailureArtifactCollector {
  private consoleLogs: ConsoleLogEntry[] = [];
  private networkRequests: NetworkRequestEntry[] = [];
  private isAttached = false;

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

    // Collect console messages
    this.page.on('console', (msg) => {
      const msgType = msg.type();
      let type: ConsoleLogEntry['type'] = 'log';
      if (msgType === 'error') {
        type = 'error';
      } else if (msgType === 'warning') {
        type = 'warning';
      } else if (msgType === 'info') {
        type = 'info';
      } else if (msgType === 'debug') {
        type = 'debug';
      }

      this.consoleLogs.push({
        type,
        text: msg.text(),
        timestamp: Date.now(),
        location: msg.location()?.url,
      });
    });

    // Collect page errors
    this.page.on('pageerror', (error) => {
      this.consoleLogs.push({
        type: 'error',
        text: `Page Error: ${error.message}`,
        timestamp: Date.now(),
      });
    });

    // Collect network requests
    this.page.on('requestfinished', async (request) => {
      const response = await request.response();
      this.networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: response?.status() ?? null,
        timing: request.timing().responseEnd,
        failed: false,
      });
    });

    this.page.on('requestfailed', (request) => {
      this.networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: null,
        timing: null,
        failed: true,
        failureReason: request.failure()?.errorText,
      });
    });

    this.isAttached = true;
  }

  /**
   * Stop collecting and clean up listeners
   */
  detach(): void {
    // Playwright automatically removes listeners when page closes
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
      const [url, title, viewportSize, localStorage] = await Promise.all([
        Promise.resolve(this.page.url()),
        this.page.title(),
        this.page.viewportSize(),
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
        url,
        title,
        viewportSize,
        localStorage,
        timestamp: Date.now(),
      };
    } catch (error) {
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
      testName: testInfo.title,
      testFile: testInfo.file,
      timestamp: new Date().toISOString(),
      duration: testInfo.duration,
      retryCount: testInfo.retry,
      error: error?.message,
      stack: error?.stack,
      consoleLogs: this.getConsoleLogs(),
      networkRequests: this.getNetworkRequests(),
      appState,
      domSnapshot,
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
export type TestHealthMetrics = {
  totalConsoleErrors: number;
  totalFailedRequests: number;
  averageTestDuration: number;
  flakyTests: string[];
  commonErrors: Array<{ message: string; count: number }>;
};

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
    .map(([message, count]) => ({ message, count }));

  return {
    totalConsoleErrors: consoleErrors.length,
    totalFailedRequests: failedRequests.length,
    averageTestDuration:
      diagnosticsList.reduce((sum, d) => sum + d.duration, 0) / diagnosticsList.length || 0,
    flakyTests: [...new Set(flakyTests)],
    commonErrors,
  };
}
