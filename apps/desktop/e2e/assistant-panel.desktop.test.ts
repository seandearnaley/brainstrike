import type { SecretsWriteResult } from '@brainstrike/assistant-contract/secrets-bridge';
import type { JSHandle, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

type ProviderWriteOutcome = 'success' | 'rejected' | 'immediate-rejected' | 'failed' | 'navigation';

interface ProviderWriteTestState {
  __pendingProviderWrite?: WeakRef<Promise<SecretsWriteResult> & { settle: () => void }>;
  __providerConfigured?: boolean;
}

async function installCollectibleProviderWrite(
  page: Page,
  outcome: ProviderWriteOutcome
): Promise<void> {
  await page.evaluate((writeOutcome) => {
    const globals = window as Window & ProviderWriteTestState;
    globals.__pendingProviderWrite = undefined;
    globals.__providerConfigured = false;
    Reflect.set(globals, '__brainstrikeTestHooks__', {
      notifySecretsChanged: () => {},
      setAssistantModel: () => {
        globals.__providerConfigured = true;
      },
    });
    Reflect.set(globals, 'secrets', {
      saveKey: () => {
        let resolve: ((value: SecretsWriteResult) => void) | undefined;
        let reject: ((error: Error) => void) | undefined;
        const completion = Object.assign(
          new Promise<SecretsWriteResult>((resolveWrite, rejectWrite) => {
            resolve = resolveWrite;
            reject = rejectWrite;
          }),
          {
            settle: () => {
              if (!(resolve && reject)) {
                throw new Error('Provider write resolvers are unavailable');
              }
              if (writeOutcome === 'rejected') {
                reject(new Error('Provider write was rejected'));
                return;
              }
              resolve(writeOutcome === 'failed' ? { error: 'unknown_error', ok: false } : true);
            },
          }
        );
        // Deliberately let the caller own the pending operation. This is the
        // V8 inspector lifetime reproducer's WeakRef/resolver contract, at
        // the public assistant setup seam instead of a disconnected snippet.
        globals.__pendingProviderWrite = new WeakRef(completion);
        if (writeOutcome === 'immediate-rejected') {
          if (!reject) {
            throw new Error('Provider write rejecter is unavailable');
          }
          reject(new Error('Provider write was rejected'));
        }
        return completion;
      },
    });
  }, outcome);
}

test.describe('Assistant panel (desktop)', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await setupAssistantMock(window, { variant: 'simple' });
    await ensureMockWorkspaceOpen(window);
  });

  test('initial assistant mount does not reload the visible renderer', async ({ window }) => {
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    const assistantChatCard = await ensureAssistantShellVisible(window);
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {
        throw new Error('Assistant UI chunk did not finish loading on initial mount');
      });
    }

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 25_000 });
    await expect
      .poll(async () => window.evaluate(() => performance.timeOrigin), {
        message: 'Initial assistant mount should not reload the visible renderer',
        timeout: 10_000,
      })
      .toBe(initialTimeOrigin);
  });

  test('prompts loads in the sidebar while the assistant shell stays available', async ({
    window,
  }) => {
    const assistantChatCard = await ensureAssistantShellVisible(window);
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const promptsTab = window.getByTestId('prompts-tab-trigger');
    await expect(promptsTab).toBeVisible({ timeout: 10_000 });
    await promptsTab.click();

    await expect(window.getByRole('region', { name: 'Prompt workbench' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(assistantChatCard).toBeVisible();

    const clip = 'Cite exact file and line evidence before drawing a conclusion.';
    const quickCapture = window.getByRole('textbox', { name: 'Quick capture' });
    await quickCapture.fill(clip);
    await quickCapture.press('Meta+Enter');

    const primaryAction = window.getByRole('button', { name: `Insert ${clip}` }).first();
    await expect(primaryAction).toBeVisible({ timeout: 5000 });
    const workbench = window.getByRole('region', { name: 'Prompt workbench' });
    const [actionBox, workbenchBox] = await Promise.all([
      primaryAction.boundingBox(),
      workbench.boundingBox(),
    ]);
    expect(actionBox).not.toBeNull();
    expect(workbenchBox).not.toBeNull();
    expect((actionBox?.x ?? 0) + (actionBox?.width ?? 0)).toBeLessThanOrEqual(
      (workbenchBox?.x ?? 0) + (workbenchBox?.width ?? 0) + 1
    );

    const libraryViewport = window.getByTestId('prompt-library-scroll');
    await expect
      .poll(async () =>
        libraryViewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      )
      .toBe(true);
  });

  test('send message and see streamed response in assistant shell', async ({ window }) => {
    const initialTimeOrigin = await window.evaluate(() => performance.timeOrigin);
    const assistantChatCard = await ensureAssistantShellVisible(window);
    await expect(assistantChatCard).toBeVisible({ timeout: 5000 });

    const loadingIndicator = window.getByText(/Loading assistant/i);
    if (await loadingIndicator.isVisible().catch(() => false)) {
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {
        console.warn('⚠️ Assistant UI chunk still loading after timeout');
      });
    }

    const chatPanel = window.getByTestId('chat-panel');
    await expect(chatPanel).toBeVisible({ timeout: 25_000 });
    await expect
      .poll(async () => window.evaluate(() => performance.timeOrigin), {
        message: 'Opening the assistant should not reload the visible renderer',
        timeout: 5000,
      })
      .toBe(initialTimeOrigin);

    const input = window.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('hello desktop');

    const sendBtn = window.getByRole('button', { exact: true, name: 'Send' });
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    await expect(window.getByText('hello desktop').first()).toBeVisible({ timeout: 10_000 });
    await expect(window.getByText('Hello from desktop assistant!').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('assistant provider setup owns pending writes and releases them on every outcome', async ({
    electronApp,
  }) => {
    // The production contextBridge is frozen. Use a separate Electron renderer
    // to control the writer lifetime without changing the app's real bridge.
    const isolatedPage = electronApp.app.waitForEvent('window');
    await electronApp.app.evaluate(({ BrowserWindow }) => {
      const window = new BrowserWindow({ show: false });
      return window.loadURL('about:blank');
    });
    const page = await isolatedPage;
    const session = await page.context().newCDPSession(page);
    const ownedHandles: JSHandle<unknown>[] = [];
    const disposedHandles = new Set<JSHandle<unknown>>();
    // Observe the public ownership boundary without requiring V8 to reclaim
    // the object by a deadline. Delegate every operation to the real Page.
    const observedPage = new Proxy(page, {
      get(target, property) {
        if (property === 'evaluateHandle') {
          return async (...args: Parameters<Page['evaluateHandle']>) => {
            const handle = await target.evaluateHandle(...args);
            ownedHandles.push(handle);
            const dispose = handle.dispose.bind(handle);
            handle.dispose = async () => {
              await dispose();
              disposedHandles.add(handle);
            };
            return handle;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      for (const outcome of [
        'success',
        'rejected',
        'immediate-rejected',
        'failed',
        'navigation',
      ] as const) {
        await test.step(outcome, async () => {
          await installCollectibleProviderWrite(page, outcome);
          const handlesBefore = ownedHandles.length;
          const setup = setupAssistantMock(observedPage).then(
            () => ({ error: null }),
            (error: unknown) => ({ error: String(error) })
          );
          await page.waitForFunction(
            () => (window as Window & ProviderWriteTestState).__pendingProviderWrite !== undefined
          );
          if (outcome === 'navigation') {
            await page.reload();
            expect((await setup).error).toContain('Execution context was destroyed');
            expect(pageErrors).toEqual([]);
            expect(ownedHandles).toHaveLength(handlesBefore + 1);
            expect(disposedHandles.size).toBe(ownedHandles.length);
            return;
          }
          // Immediate rejection has already settled; this case checks same-turn
          // rejection observation, not survival of a still-pending operation.
          if (outcome !== 'immediate-rejected') {
            await session.send('HeapProfiler.collectGarbage');
          }
          const pendingWriteIsAlive = await page.evaluate(() => {
            const completion = (
              window as Window & ProviderWriteTestState
            ).__pendingProviderWrite?.deref();
            if (!completion) {
              return false;
            }
            completion.settle();
            return true;
          });
          const result = await setup;
          if (outcome === 'success') {
            expect(result.error).toBeNull();
          } else {
            expect(result.error).toContain(
              outcome === 'rejected' || outcome === 'immediate-rejected'
                ? 'Provider write was rejected'
                : 'Assistant provider key save failed: unknown_error'
            );
          }
          expect(pageErrors).toEqual([]);
          expect(pendingWriteIsAlive).toBe(true);
          expect(
            await page.evaluate(
              () => (window as Window & ProviderWriteTestState).__providerConfigured
            )
          ).toBe(outcome === 'success');
          expect(ownedHandles).toHaveLength(handlesBefore + 1);
          expect(disposedHandles.size).toBe(ownedHandles.length);
          // The renderer remains usable while the released handle does not.
          expect(await page.evaluate(() => true)).toBe(true);
          const handle = ownedHandles.at(-1);
          if (!handle) {
            throw new Error('The provider setup did not create an owned handle');
          }
          await expect(handle.evaluate(() => true)).rejects.toThrow();
        });
      }
    } finally {
      try {
        await session.detach();
      } finally {
        await page.close();
      }
    }
  });
});
