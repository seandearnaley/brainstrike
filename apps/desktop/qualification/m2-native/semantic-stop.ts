import { expect, type Page } from '@playwright/test';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import type {
  EmbeddingHostQueryEmbeddingCancel,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
} from '../../src/embedding-host-shared';
import { DESKTOP_IPC_CHANNELS } from '../../src/platform/desktop-ipc-channels';
import type { PublicBridges } from './public-bridges';

interface HiddenQueryEvent {
  readonly at: number;
  readonly kind: 'request' | 'cancel';
  readonly value: EmbeddingHostQueryEmbeddingRequest | EmbeddingHostQueryEmbeddingCancel;
}
interface TerminalEvent {
  readonly at: number;
  readonly kind: 'report' | 'destroyed';
  readonly senderId: number;
  readonly value?: EmbeddingHostQueryEmbeddingResponseReport;
}
interface MainObservation {
  readonly dispose: () => void;
  readonly events: TerminalEvent[];
}

export interface SemanticObservation {
  readonly close: () => Promise<void>;
  readonly diagnostics: () => Promise<
    Awaited<ReturnType<NonNullable<PublicBridges['desktopDiagnostics']>['getSnapshot']>>
  >;
  readonly events: () => Promise<readonly HiddenQueryEvent[]>;
  readonly terminals: () => Promise<readonly TerminalEvent[]>;
}

/** Observe existing public request/cancel events and actual IPC terminal reports; never replace inference. */
export async function observeSemanticQuery(
  context: ElectronAppContext
): Promise<SemanticObservation> {
  const hosts = context.app
    .windows()
    .filter((page) => new URL(page.url()).searchParams.get('mode') === 'embedding-host');
  expect(hosts).toHaveLength(1);
  const host = hosts[0];
  if (!host) {
    throw new Error('Actual hidden embedding renderer is unavailable.');
  }
  const hostWindow = await context.app.browserWindow(host);
  const senderId = await hostWindow.evaluate((window) => window.webContents.id);
  const hiddenEvents: HiddenQueryEvent[] = [];
  await host.exposeBinding('__m2ObserveQueryEvent', (_source, event: HiddenQueryEvent) => {
    hiddenEvents.push(event);
  });
  await host.evaluate(() => {
    const ledger = window as typeof window & {
      __m2QueryEvents?: HiddenQueryEvent[];
      __m2QueryUnsubscribe?: () => void;
    };
    const bridge = (window as unknown as PublicBridges).embeddingHost;
    if (!(bridge?.onQueryEmbeddingRequest && bridge.onQueryEmbeddingCancel)) {
      throw new Error('Hidden query observation capability is unavailable.');
    }
    const events: HiddenQueryEvent[] = [];
    const publish = (event: HiddenQueryEvent): void => {
      events.push(event);
      void (
        window as typeof window & { __m2ObserveQueryEvent(event: HiddenQueryEvent): Promise<void> }
      ).__m2ObserveQueryEvent(event);
    };
    const unsubscribes = [
      bridge.onQueryEmbeddingRequest((value) =>
        publish({ at: Date.now(), kind: 'request', value })
      ),
      bridge.onQueryEmbeddingCancel((value) => publish({ at: Date.now(), kind: 'cancel', value })),
    ];
    ledger.__m2QueryEvents = events;
    ledger.__m2QueryUnsubscribe = () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  });
  await context.app.evaluate(
    ({ ipcMain, BrowserWindow }, { channel, senderId }) => {
      const target = globalThis as typeof globalThis & {
        __m2SemanticObservation?: MainObservation;
      };
      if (target.__m2SemanticObservation) {
        throw new Error('Previous semantic observation remains owned.');
      }
      const events: TerminalEvent[] = [];
      const report = (
        event: Electron.IpcMainEvent,
        value: EmbeddingHostQueryEmbeddingResponseReport
      ): void => {
        if (event.sender.id === senderId) {
          events.push({ at: Date.now(), kind: 'report', senderId, value });
        }
      };
      const contents = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.id === senderId
      )?.webContents;
      if (!contents) {
        throw new Error('Actual hidden sender disappeared before observation.');
      }
      const destroyed = (): void => {
        events.push({ at: Date.now(), kind: 'destroyed', senderId });
      };
      ipcMain.on(channel, report);
      contents.on('destroyed', destroyed);
      target.__m2SemanticObservation = {
        dispose: () => {
          ipcMain.removeListener(channel, report);
          contents.removeListener('destroyed', destroyed);
          target.__m2SemanticObservation = undefined;
        },
        events,
      };
    },
    { channel: DESKTOP_IPC_CHANNELS.embeddingHost.reportQueryEmbeddingResponse, senderId }
  );
  const events = async (): Promise<readonly HiddenQueryEvent[]> => [...hiddenEvents];
  return {
    close: async () => {
      if (!host.isClosed()) {
        await disposeHiddenObservation(host);
      }
      await context.app.evaluate(() =>
        (
          globalThis as typeof globalThis & { __m2SemanticObservation?: MainObservation }
        ).__m2SemanticObservation?.dispose()
      );
    },
    diagnostics: async () =>
      await context.window.evaluate(async () => {
        const diagnostics = (window as unknown as PublicBridges).desktopDiagnostics;
        if (!diagnostics) {
          throw new Error('Public pending ownership diagnostics unavailable.');
        }
        return await diagnostics.getSnapshot();
      }),
    events,
    terminals: async () =>
      await context.app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __m2SemanticObservation?: MainObservation })
            .__m2SemanticObservation?.events ?? []
      ),
  };
}

async function disposeHiddenObservation(host: Page): Promise<void> {
  await host.evaluate(() => {
    const ledger = window as typeof window & {
      __m2QueryUnsubscribe?: () => void;
      __m2QueryEvents?: HiddenQueryEvent[];
    };
    ledger.__m2QueryUnsubscribe?.();
    ledger.__m2QueryUnsubscribe = undefined;
    ledger.__m2QueryEvents = undefined;
  });
}
