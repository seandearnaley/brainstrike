import type { MainWatchdogMessage } from './main-watchdog-core';

export interface MainWatchdogFileLoggingState {
  destination: string | null;
  enabled: boolean;
}

type PostMainWatchdogMessage = (message: MainWatchdogMessage) => void;

export interface MainWatchdogRuntime {
  attach: (postMessage: PostMainWatchdogMessage, fileLogging: MainWatchdogFileLoggingState) => void;
  configureLogging: (fileLogging: MainWatchdogFileLoggingState) => boolean;
  detach: () => void;
  heartbeat: () => boolean;
  resume: () => boolean;
  suspend: () => boolean;
}

export interface MainWatchdogAttachmentLifecycle {
  attach: (postMessage: PostMainWatchdogMessage, fileLogging: MainWatchdogFileLoggingState) => void;
  detachIfAttached: () => boolean;
}

interface MainWatchdogDeliveryFailure {
  error: unknown;
  message: MainWatchdogMessage;
}

interface MainWatchdogRuntimeOptions {
  onDeliveryError: (failure: MainWatchdogDeliveryFailure) => void;
}

export function attemptMainWatchdogBootstrap(
  start: () => void,
  onError: (error: unknown) => void
): boolean {
  try {
    start();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

/** Diagnostics attach before renderer readiness waits; bootstrap failure stays nonfatal. */
export function startMainWatchdogBeforeWindow<Window>(
  start: () => void,
  onError: (error: unknown) => void,
  createWindow: () => Promise<Window>
): Promise<Window> {
  attemptMainWatchdogBootstrap(start, onError);
  return createWindow();
}

export function runMainWatchdogPowerTransition(
  runtime: Pick<MainWatchdogRuntime, 'resume' | 'suspend'>,
  type: 'resume' | 'suspend',
  transition: () => void
): void {
  if (type === 'suspend') {
    runtime.suspend();
  } else {
    runtime.resume();
  }
  transition();
}

function resolveLogPath(fileLogging: MainWatchdogFileLoggingState): string | null {
  if (!fileLogging.enabled) {
    return null;
  }
  if (fileLogging.destination === null || fileLogging.destination.trim().length === 0) {
    throw new Error('Main watchdog file logging is enabled without a destination');
  }
  return fileLogging.destination;
}

export function createMainWatchdogRuntime(
  options: MainWatchdogRuntimeOptions
): MainWatchdogRuntime {
  let activePostMessage: PostMainWatchdogMessage | null = null;

  const deliver = (message: MainWatchdogMessage): boolean => {
    if (activePostMessage === null) {
      options.onDeliveryError({
        error: new Error('Main watchdog runtime is not attached'),
        message,
      });
      return false;
    }
    try {
      activePostMessage(message);
      return true;
    } catch (error) {
      options.onDeliveryError({ error, message });
      return false;
    }
  };

  const attach = (
    postMessage: PostMainWatchdogMessage,
    fileLogging: MainWatchdogFileLoggingState
  ): void => {
    if (activePostMessage !== null) {
      throw new Error('Main watchdog runtime is already attached');
    }

    const logPath = resolveLogPath(fileLogging);
    activePostMessage = postMessage;
    try {
      postMessage({ logPath, type: 'config' });
    } catch (error) {
      activePostMessage = null;
      throw error;
    }
  };

  const configureLogging = (fileLogging: MainWatchdogFileLoggingState): boolean =>
    deliver({ logPath: resolveLogPath(fileLogging), type: 'config' });

  const detach = (): void => {
    if (activePostMessage === null) {
      throw new Error('Main watchdog runtime is not attached');
    }
    activePostMessage = null;
  };

  const postLifecycleMessage = (type: 'heartbeat' | 'resume' | 'suspend'): boolean =>
    deliver({ type });

  return {
    attach,
    configureLogging,
    detach,
    heartbeat: () => postLifecycleMessage('heartbeat'),
    resume: () => postLifecycleMessage('resume'),
    suspend: () => postLifecycleMessage('suspend'),
  };
}

export function createMainWatchdogAttachmentLifecycle(
  runtime: MainWatchdogRuntime
): MainWatchdogAttachmentLifecycle {
  let attached = false;

  const attach = (
    postMessage: PostMainWatchdogMessage,
    fileLogging: MainWatchdogFileLoggingState
  ): void => {
    if (attached) {
      throw new Error('Main watchdog attachment lifecycle is already attached');
    }

    runtime.attach(postMessage, fileLogging);
    attached = true;
  };

  const detachIfAttached = (): boolean => {
    if (!attached) {
      return false;
    }

    attached = false;
    runtime.detach();
    return true;
  };

  return { attach, detachIfAttached };
}
