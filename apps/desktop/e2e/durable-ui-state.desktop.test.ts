import { once } from 'node:events';
import { expect, test } from './fixtures/electron-fixture';
import { waitForAppHost } from './utils/agent-host-log';
import {
  closeLastWindowLikeTheUser,
  expandFixtureFolder,
  openDurableUiFixture,
  readCommittedThreadExpansion,
  readPanelLayout,
  readStoredExplorerExpansion,
  reloadFromMenu,
  resizeFirstPanel,
} from './utils/durable-ui-state';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/**
 * ADR-0026 R1: every unload of a visible document flushes its durable writers first, so the last
 * write survives quit, window-X and reload (`docs/agents/platform-contracts.md`, "Document unload
 * flushes the two durable writers"). Explorer state is saved synchronously in `localStorage`.
 */
test.describe('durable UI state across document unload', () => {
  test('an Explorer expansion 200 ms before window-X is stored and in the thread snapshot after relaunch', async ({
    electron,
    window,
  }) => {
    const fixture = await openDurableUiFixture(electron, window);
    const { page } = fixture;
    const userDataDir = electron.getUserDataDir();
    await expandFixtureFolder(page);
    await page.waitForTimeout(200);
    const closed = await closeLastWindowLikeTheUser(electron, page);
    if (closed.quit) {
      expect(closed.exitCode).toBe(0);
    } else {
      // The Dock or tray keeps the app and its host running windowless: no new document can
      // rewrite them.
      expect
        .soft(await readCommittedThreadExpansion(userDataDir, fixture.threadId))
        .toContain(fixture.expandedPath);
      await electron.dispose();
    }
    const relaunched = await electron.ensureWindow({ preserveState: true });
    expect(await readStoredExplorerExpansion(relaunched)).toContain(fixture.expandedPath);
    await ensureAssistantShellVisible(relaunched);
    await waitForAppHost(relaunched);
    expect(await readCommittedThreadExpansion(userDataDir, fixture.threadId)).toContain(
      fixture.expandedPath
    );
  });

  test('a thread-workspace edit 300 ms before menu Reload is committed before the new document loads', async ({
    electron,
    window,
  }) => {
    const fixture = await openDurableUiFixture(electron, window);
    const { page } = fixture;
    const userDataDir = electron.getUserDataDir();
    await expandFixtureFolder(page);
    await page.waitForTimeout(300);
    const navigated = page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === page.mainFrame(),
    });
    await reloadFromMenu((await electron.ensureContext()).app, page);
    await navigated;
    // Read before the replacement document has attached to the host and could write anything.
    expect(await readCommittedThreadExpansion(userDataDir, fixture.threadId)).toContain(
      fixture.expandedPath
    );
    const { waitForAppReady } = await loadElectronHelpers();
    await waitForAppReady(page);
    await ensureAssistantShellVisible(page);
    await waitForAppHost(page);
    expect(await readCommittedThreadExpansion(userDataDir, fixture.threadId)).toContain(
      fixture.expandedPath
    );
  });
});

const RENDERER_FLUSH_MS = 12_000;

interface LogRecord {
  readonly level?: number;
  readonly msg?: string;
  readonly steps?: readonly { readonly elapsedMs: number; readonly step: string }[];
}

/** Main's structured stdout records; the last segment is a line still being written. */
function parse(output: string): LogRecord[] {
  return output
    .split('\n')
    .slice(0, -1)
    .flatMap((line) => {
      if (!line.startsWith('{')) {
        return [];
      }
      const record: unknown = JSON.parse(line);
      return typeof record === 'object' && record !== null ? [record as LogRecord] : [];
    });
}

/**
 * The slow-machine matrix (lifecycle redesign §6.1): the renderer's flush ACK reaches Main 12 s
 * late, longer than any deadline Main used to race. A change in each durable writer, made
 * the instant before the unload, still survives it; the app exits 0 with no error-level record.
 */
test.describe('durable UI state under a 12 s renderer flush', () => {
  test.use({
    electronEnv: {
      BRAINSTRIKE_E2E_LIFECYCLE_DELAYS: `renderer-flush:${RENDERER_FLUSH_MS}`,
      LOG_LEVEL: 'info',
    },
  });

  for (const unload of ['quit', 'window-X', 'reload'] as const) {
    test(`every durable writer's last change survives ${unload}`, async ({
      electron,
      window,
    }, testInfo) => {
      test.setTimeout(240_000);
      const fixture = await openDurableUiFixture(electron, window);
      const { page } = fixture;
      const userDataDir = electron.getUserDataDir();
      const { app } = await electron.ensureContext();
      const main = app.process();
      let output = '';
      main.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      try {
        const panelBefore = await readPanelLayout(page);
        await expandFixtureFolder(page);
        await resizeFirstPanel(page);
        // No wait: every writer's tail is still buffered when the unload starts.
        const started = Date.now();
        let unloadMs: number | undefined;
        let reopened = page;
        if (unload === 'reload') {
          const navigated = page.waitForEvent('framenavigated', {
            predicate: (frame) => frame === page.mainFrame(),
            timeout: RENDERER_FLUSH_MS + 30_000,
          });
          await reloadFromMenu(app, page);
          await navigated;
          unloadMs = Date.now() - started;
          const { waitForAppReady } = await loadElectronHelpers();
          await waitForAppReady(page);
        } else {
          if (unload === 'quit') {
            await Promise.all([once(main, 'close'), electron.dispose()]);
            expect({ code: main.exitCode, signal: main.signalCode }).toEqual({
              code: 0,
              signal: null,
            });
            unloadMs = parse(output)
              .find((record) => record.msg === 'Graceful shutdown completed')
              ?.steps?.find((step) => step.step === 'renderers')?.elapsedMs;
          } else {
            const closed = await closeLastWindowLikeTheUser(electron, page);
            unloadMs = Date.now() - started;
            if (closed.quit) {
              expect(closed.exitCode).toBe(0);
            } else {
              await Promise.all([once(main, 'close'), electron.dispose()]);
              expect(main.exitCode).toBe(0);
            }
          }
          reopened = await electron.ensureWindow({ preserveState: true });
        }
        // Each writer reports on its own, so one run names every write that was lost.
        expect.soft(await readStoredExplorerExpansion(reopened)).toContain(fixture.expandedPath);
        const panelAfter = await readPanelLayout(reopened);
        expect.soft(panelAfter).not.toBeNull();
        expect.soft(panelAfter).not.toBe(panelBefore);
        await ensureAssistantShellVisible(reopened);
        await waitForAppHost(reopened);
        expect
          .soft(await readCommittedThreadExpansion(userDataDir, fixture.threadId))
          .toContain(fixture.expandedPath);
        // The unload waited for the late flush instead of racing it.
        expect(unloadMs).toBeGreaterThanOrEqual(RENDERER_FLUSH_MS);
        const records = parse(output);
        expect(records.filter((record) => (record.level ?? 0) >= 50)).toEqual([]);
      } finally {
        await testInfo.attach(`durable-ui-${unload}-main-log`, {
          body: output,
          contentType: 'text/plain',
        });
      }
    });
  }
});
