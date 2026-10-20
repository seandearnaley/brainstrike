import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { tearDownElectronTest } from '../../e2e/fixtures/electron-teardown';
import { attachFailureScreenshot } from '../../e2e/utils/failure-screenshot';

type Attachment = Parameters<TestInfo['attach']>[1] & { readonly name: string };

function testInfo(
  status: TestInfo['status'],
  expectedStatus: TestInfo['expectedStatus'] = 'passed'
) {
  const attachments: Attachment[] = [];
  return {
    attachments,
    info: {
      attach: async (name: string, options: Parameters<TestInfo['attach']>[1] = {}) => {
        attachments.push({ name, ...options });
      },
      expectedStatus,
      outputPath: (...segments: string[]) => join('/out', ...segments),
      status,
    },
  };
}

function window(screenshot: Page['screenshot'], closed = false): Page {
  return { isClosed: () => closed, screenshot } as unknown as Page;
}

describe('desktop E2E failure screenshot (BST-2239)', () => {
  it('Playwright takes no screenshot of the closing app: the close deadline never pays for one', () => {
    // With 'only-on-failure', Playwright screenshots every page of the closing app before it asks
    // Main to quit; a hidden window took 2.2-5 s on hosted windows-2025, inside the 10 s deadline.
    const config = readFileSync(join(process.cwd(), 'playwright.config.mts'), 'utf8');
    expect(config).toMatch(/screenshot: 'off',/u);
    expect(config).not.toMatch(/screenshot: 'only-on-failure'/u);
  });

  it('the fixture keeps the failure visual: it screenshots the main window before disposing the app', () => {
    expect(readFileSync(join(process.cwd(), 'e2e/fixtures/electron-fixture.ts'), 'utf8')).toContain(
      'await tearDownElectronTest(harness, testInfo, userDataDir, workspaceRoot);'
    );
    const fixture = readFileSync(join(process.cwd(), 'e2e/fixtures/electron-teardown.ts'), 'utf8');
    const captured = fixture.indexOf(
      'await attachFailureScreenshot(harness.currentWindow(), testInfo)'
    );
    expect(captured).toBeGreaterThan(-1);
    expect(captured).toBeLessThan(fixture.indexOf('await harness.dispose()'));
  });

  it('screenshots the main window and attaches it when the test failed', async () => {
    const screenshot = vi.fn(async () => Buffer.alloc(0));
    const { attachments, info } = testInfo('failed');
    await attachFailureScreenshot(window(screenshot), info);
    expect(screenshot).toHaveBeenCalledWith({ path: '/out/test-failed-1.png', timeout: 5000 });
    expect(attachments).toEqual([
      { contentType: 'image/png', name: 'screenshot', path: '/out/test-failed-1.png' },
    ]);
  });

  it('takes nothing when the test ended as expected', async () => {
    const screenshot = vi.fn(async () => Buffer.alloc(0));
    for (const [status, expected] of [
      ['passed', 'passed'],
      ['skipped', 'skipped'],
      ['failed', 'failed'],
    ] as const) {
      const { attachments, info } = testInfo(status, expected);
      await attachFailureScreenshot(window(screenshot), info);
      expect(attachments).toEqual([]);
    }
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('attaches why the visual is missing instead of skipping it silently', async () => {
    const closed = testInfo('timedOut');
    await attachFailureScreenshot(window(vi.fn(), true), closed.info);
    expect(closed.attachments.map(({ name }) => name)).toEqual(['screenshot-unavailable']);

    const failing = testInfo('failed');
    await attachFailureScreenshot(
      window(async () => {
        throw new Error('page.screenshot: Timeout 5000ms exceeded.');
      }),
      failing.info
    );
    expect(failing.attachments).toEqual([
      expect.objectContaining({
        body: expect.stringContaining('Timeout 5000ms exceeded'),
        name: 'screenshot-failed',
      }),
    ]);
  });
});

describe('desktop E2E fixture teardown (BST-2239)', () => {
  it('a failure screenshot that cannot be attached still disposes the app and removes its profile and workspace, then fails the teardown with that error', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'bs-teardown-profile-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'bs-teardown-workspace-'));
    onTestFinished(async () => {
      await rm(userDataDir, { force: true, recursive: true });
      await rm(workspaceRoot, { force: true, recursive: true });
    });
    const dispose = vi.fn(async () => undefined);
    const unwritable = new Error('ENOSPC: no space left on device, write');
    const info = {
      ...testInfo('failed').info,
      attach: async () => {
        throw unwritable;
      },
    };

    await expect(
      tearDownElectronTest(
        { currentWindow: () => undefined, dispose },
        info,
        userDataDir,
        workspaceRoot
      )
    ).rejects.toBe(unwritable);

    expect(dispose).toHaveBeenCalledOnce();
    await expect(stat(userDataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
