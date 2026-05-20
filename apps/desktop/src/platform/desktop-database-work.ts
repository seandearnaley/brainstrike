import {
  createDatabaseWorkScheduler,
  type DatabaseWorkOptions,
  type DatabaseWorkPriority,
  type DatabaseWorkScheduler,
  type DatabaseWorkSchedulerOptions,
  type DatabaseWorkSchedulerSnapshot,
} from '@brainstrike/db';
import type { IpcMainInvokeEvent } from 'electron';
import { BrowserWindow } from 'electron';

interface DatabaseWorkHostWindowMatcher {
  readonly isHostWindow: (window: BrowserWindow) => boolean;
}

interface ResolveDatabaseWorkOptionsHostManagers {
  readonly chunkingHostManager?: DatabaseWorkHostWindowMatcher;
  readonly embeddingHostManager?: DatabaseWorkHostWindowMatcher;
}

const DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS = 5000;

let desktopDatabaseWorkScheduler: DatabaseWorkScheduler = createDatabaseWorkScheduler();
let desktopDatabaseResetBarrier: Promise<void> | null = null;

function isDatabaseWorkPriority(value: unknown): value is DatabaseWorkPriority {
  return value === 'foreground' || value === 'normal' || value === 'background';
}

function parseDatabaseWorkOptions(value: unknown): DatabaseWorkOptions {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Database work options must be an object when provided.');
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'priority' && key !== 'label')) {
    throw new Error('Database work options may only include priority and label.');
  }
  const candidate = value as { label?: unknown; priority?: unknown };
  if (candidate.priority !== undefined && !isDatabaseWorkPriority(candidate.priority)) {
    throw new Error('Database work priority must be foreground, normal, or background.');
  }
  if (candidate.label !== undefined && typeof candidate.label !== 'string') {
    throw new Error('Database work label must be a string when provided.');
  }
  const options: { label?: string; priority?: DatabaseWorkPriority } = {};
  if (candidate.label !== undefined) {
    options.label = candidate.label;
  }
  if (candidate.priority !== undefined) {
    options.priority = candidate.priority;
  }
  return options;
}

function isDatabaseWorkOptionsArgument(value: unknown): value is DatabaseWorkOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'priority' && key !== 'label')) {
    return false;
  }
  const candidate = value as { label?: unknown; priority?: unknown };
  if (candidate.priority !== undefined && !isDatabaseWorkPriority(candidate.priority)) {
    return false;
  }
  return candidate.label === undefined || typeof candidate.label === 'string';
}

export function resolveSqlParamsAndWorkOptions(
  channel: string,
  paramsOrOptions: unknown,
  maybeOptions: unknown
): {
  readonly params: unknown[] | undefined;
  readonly workOptions: unknown;
} {
  if (paramsOrOptions === undefined) {
    return { params: undefined, workOptions: maybeOptions };
  }
  if (Array.isArray(paramsOrOptions)) {
    return { params: paramsOrOptions, workOptions: maybeOptions };
  }
  if (isDatabaseWorkOptionsArgument(paramsOrOptions)) {
    return { params: undefined, workOptions: paramsOrOptions };
  }
  throw new Error(`${channel} parameters must be an array when provided.`);
}

function getSenderOwnerWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  if (!event.sender) {
    return null;
  }
  const sender = event.sender as IpcMainInvokeEvent['sender'] & {
    getOwnerBrowserWindow?: () => BrowserWindow | null;
  };
  const ownerFromSender = sender.getOwnerBrowserWindow?.();
  if (ownerFromSender) {
    return ownerFromSender;
  }
  const fromWebContents = (
    BrowserWindow as typeof BrowserWindow & {
      fromWebContents?: (webContents: IpcMainInvokeEvent['sender']) => BrowserWindow | null;
    }
  ).fromWebContents;
  return fromWebContents?.(event.sender) ?? null;
}

function resolveDefaultDatabaseWorkPriority(
  event: IpcMainInvokeEvent,
  options: ResolveDatabaseWorkOptionsHostManagers | undefined
): DatabaseWorkPriority {
  const ownerWindow = getSenderOwnerWindow(event);
  if (ownerWindow && options?.embeddingHostManager?.isHostWindow(ownerWindow)) {
    return 'background';
  }
  if (ownerWindow && options?.chunkingHostManager?.isHostWindow(ownerWindow)) {
    return 'background';
  }
  return 'foreground';
}

function resolveDatabaseWorkOptions(
  event: IpcMainInvokeEvent,
  registerOptions: ResolveDatabaseWorkOptionsHostManagers | undefined,
  explicitOptions: unknown,
  fallbackLabel: string
): DatabaseWorkOptions {
  const parsedOptions = parseDatabaseWorkOptions(explicitOptions);
  return {
    label: parsedOptions.label ?? fallbackLabel,
    priority: parsedOptions.priority ?? resolveDefaultDatabaseWorkPriority(event, registerOptions),
  };
}

export function getDesktopDatabaseWorkScheduler(): DatabaseWorkScheduler {
  return desktopDatabaseWorkScheduler;
}

export function getDesktopDatabaseWorkSchedulerSnapshot(): DatabaseWorkSchedulerSnapshot {
  return desktopDatabaseWorkScheduler.getSnapshot();
}

export function runScheduledDatabaseWork<T>(
  event: IpcMainInvokeEvent,
  registerOptions: ResolveDatabaseWorkOptionsHostManagers | undefined,
  explicitOptions: unknown,
  fallbackLabel: string,
  operation: () => Promise<T>
): Promise<T> {
  const workOptions = resolveDatabaseWorkOptions(
    event,
    registerOptions,
    explicitOptions,
    fallbackLabel
  );
  return waitForDesktopDatabaseResetBarrier().then(() =>
    desktopDatabaseWorkScheduler.run(operation, workOptions)
  );
}

export function runDesktopScheduledDatabaseWork<T>(
  options: DatabaseWorkOptions,
  operation: () => Promise<T>
): Promise<T> {
  return waitForDesktopDatabaseResetBarrier().then(() =>
    desktopDatabaseWorkScheduler.run(operation, options)
  );
}

async function waitForDesktopDatabaseResetBarrier(): Promise<void> {
  const barrier = desktopDatabaseResetBarrier;
  if (!barrier) {
    return;
  }
  await barrier;
}

export async function runWithDesktopDatabaseResetBarrier<T>(
  operation: () => Promise<T>
): Promise<T> {
  if (desktopDatabaseResetBarrier) {
    throw new Error('Desktop database reset barrier is already active.');
  }

  let releaseBarrier!: () => void;
  desktopDatabaseResetBarrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  try {
    return await operation();
  } finally {
    releaseBarrier();
    desktopDatabaseResetBarrier = null;
  }
}

function isDesktopDatabaseWorkSchedulerIdle(snapshot: DatabaseWorkSchedulerSnapshot): boolean {
  return (
    snapshot.runningPriority === null &&
    snapshot.queued.foreground === 0 &&
    snapshot.queued.normal === 0 &&
    snapshot.queued.background === 0
  );
}

export async function waitForDesktopDatabaseWorkSchedulerIdle(
  timeoutMs = DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS
): Promise<void> {
  if (isDesktopDatabaseWorkSchedulerIdle(desktopDatabaseWorkScheduler.getSnapshot())) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const resolveIfIdle = (snapshot: DatabaseWorkSchedulerSnapshot) => {
      if (!isDesktopDatabaseWorkSchedulerIdle(snapshot)) {
        return;
      }
      cleanup();
      resolve();
    };

    timeout = setTimeout(() => {
      const snapshot = desktopDatabaseWorkScheduler.getSnapshot();
      cleanup();
      reject(
        new Error(
          `Desktop database work did not become idle within ${timeoutMs}ms. ` +
            `running=${snapshot.runningLabel ?? 'none'} queued=${JSON.stringify(snapshot.queued)}`
        )
      );
    }, timeoutMs);

    unsubscribe = desktopDatabaseWorkScheduler.subscribe(resolveIfIdle);
    resolveIfIdle(desktopDatabaseWorkScheduler.getSnapshot());
  });
}

export function resetDesktopDatabaseWorkSchedulerForTests(
  options?: DatabaseWorkSchedulerOptions
): void {
  desktopDatabaseWorkScheduler = createDatabaseWorkScheduler(options);
  desktopDatabaseResetBarrier = null;
}
