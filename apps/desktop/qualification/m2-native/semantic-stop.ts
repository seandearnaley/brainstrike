import { expect, type Page } from '@playwright/test';
import type { NativeLocalSelection } from '../../../../packages/indexing-contract/src/indexer-producer';
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

interface WorkerSubmission {
  readonly at: number;
  readonly message: unknown;
  readonly releasedAt: number | null;
}
interface SubmissionBarrier {
  readonly read: () => WorkerSubmission | null;
  readonly release: () => void;
  readonly restore: () => void;
}

export interface SemanticObservation {
  readonly close: () => Promise<void>;
  readonly diagnostics: () => Promise<
    Awaited<ReturnType<NonNullable<PublicBridges['desktopDiagnostics']>['getSnapshot']>>
  >;
  readonly events: () => Promise<readonly HiddenQueryEvent[]>;
  readonly releaseSubmission: () => Promise<void>;
  readonly restoreSubmission: () => Promise<void>;
  readonly submission: () => Promise<WorkerSubmission | null>;
  readonly terminals: () => Promise<readonly TerminalEvent[]>;
}

/** Observe existing public request/cancel events and actual IPC terminal reports; never replace inference. */
export async function observeSemanticQuery(
  context: ElectronAppContext,
  match: { readonly workerText: string; readonly plan: NativeLocalSelection }
): Promise<SemanticObservation> {
  const hosts = context.app
    .windows()
    .filter((page) => new URL(page.url()).searchParams.get('mode') === 'embedding-host');
  expect(hosts).toHaveLength(1);
  const host = hosts[0];
  if (!host) {
    throw new Error('Actual hidden embedding renderer is unavailable.');
  }
  // Hold one real workerpool RPC before submission, while the adapter owns its
  // execution promise and signal. All other real Worker traffic stays unchanged.
  await host.evaluate((match) => {
    const ledger = window as typeof window & { __m2SubmissionBarrier?: SubmissionBarrier };
    if (ledger.__m2SubmissionBarrier) {
      throw new Error('Previous worker submission barrier remains owned.');
    }
    const original = Worker.prototype.postMessage;
    let held: {
      worker: Worker;
      args: [unknown, (Transferable[] | StructuredSerializeOptions)?];
    } | null = null;
    let submission: WorkerSubmission | null = null;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]
    ): void {
      const message = args[0];
      const params =
        message && typeof message === 'object' && 'params' in message ? message.params : null;
      const request: unknown = Array.isArray(params) && params.length === 1 ? params[0] : null;
      if (
        !(
          message &&
          typeof message === 'object' &&
          'method' in message &&
          message.method === 'runEmbedding' &&
          'id' in message &&
          (typeof message.id === 'number' || typeof message.id === 'string') &&
          request &&
          typeof request === 'object' &&
          'type' in request &&
          request.type === 'embed' &&
          'id' in request &&
          typeof request.id === 'string' &&
          'texts' in request &&
          Array.isArray(request.texts) &&
          request.texts.length === 1 &&
          request.texts[0] === match.workerText &&
          'model' in request &&
          request.model === match.plan.modelId &&
          'revision' in request &&
          request.revision === match.plan.revision &&
          'deviceHint' in request &&
          request.deviceHint === match.plan.device &&
          'dtype' in request &&
          request.dtype === match.plan.dtype &&
          'targetDimension' in request &&
          request.targetDimension === match.plan.dimensions
        )
      ) {
        Reflect.apply(original, this, args);
        return;
      }
      if (submission) {
        throw new Error('The one-shot semantic worker submission matched twice.');
      }
      held = { args, worker: this };
      submission = { at: Date.now(), message, releasedAt: null };
    };
    const release = (): void => {
      if (!(held && submission)) {
        return;
      }
      const current = held;
      held = null;
      submission = { ...submission, releasedAt: Date.now() };
      Reflect.apply(original, current.worker, current.args);
    };
    ledger.__m2SubmissionBarrier = {
      read: () => submission,
      release,
      restore: () => {
        try {
          release();
        } finally {
          Worker.prototype.postMessage = original;
          ledger.__m2SubmissionBarrier = undefined;
        }
      },
    };
  }, match);
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
      try {
        if (!host.isClosed()) {
          await disposeHiddenObservation(host);
        }
      } finally {
        await context.app.evaluate(() =>
          (
            globalThis as typeof globalThis & { __m2SemanticObservation?: MainObservation }
          ).__m2SemanticObservation?.dispose()
        );
      }
    },
    diagnostics: async () =>
      await context.window.evaluate(async () => {
        const diagnostics = (window as unknown as PublicBridges).desktopDiagnostics;
        if (!diagnostics) {
          throw new Error('Public pending ownership diagnostics unavailable.');
        }
        const response = await diagnostics.getSnapshot();
        if (!response.ok) {
          throw new Error(JSON.stringify(response.error));
        }
        return response.value;
      }),
    events,
    releaseSubmission: async () => {
      if (!host.isClosed()) {
        await host.evaluate(() =>
          (
            window as typeof window & {
              __m2SubmissionBarrier?: SubmissionBarrier;
            }
          ).__m2SubmissionBarrier?.release()
        );
      }
    },
    restoreSubmission: async () => {
      if (!host.isClosed()) {
        await host.evaluate(() =>
          (
            window as typeof window & {
              __m2SubmissionBarrier?: SubmissionBarrier;
            }
          ).__m2SubmissionBarrier?.restore()
        );
      }
    },
    submission: async () =>
      await host.evaluate(
        () =>
          (
            window as typeof window & { __m2SubmissionBarrier?: SubmissionBarrier }
          ).__m2SubmissionBarrier?.read() ?? null
      ),
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
      __m2SubmissionBarrier?: SubmissionBarrier;
    };
    ledger.__m2SubmissionBarrier?.restore();
    ledger.__m2QueryUnsubscribe?.();
    ledger.__m2QueryUnsubscribe = undefined;
    ledger.__m2QueryEvents = undefined;
  });
}
