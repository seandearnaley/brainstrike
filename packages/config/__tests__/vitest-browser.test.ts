import { describe, expect, it } from 'vitest';
import { createBrowserProject, createPlaywrightOptions } from '../src/vitest-browser';

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
      isCI: true,
      headless: false,
      testPattern: 'src/**/*.browser.test.ts',
      trace: 'on-first-retry',
      traceOutputDir: '.trace-output',
      launchArgs: ['--custom-browser-arg'],
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
});
