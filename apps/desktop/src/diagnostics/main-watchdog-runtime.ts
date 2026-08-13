import type { MainWatchdogMessage } from './main-watchdog-core';

export interface MainWatchdogFileLoggingState {
  destination: string | null;
  enabled: boolean;
}

type PostMainWatchdogMessage = (message: MainWatchdogMessage) => void;

export interface MainWatchdogRuntime {
  attach: (postMessage: PostMainWatchdogMessage, fileLogging: MainWatchdogFileLoggingState) => void;
  configureLogging: (fileLogging: MainWatchdogFileLoggingState) => void;
  detach: () => void;
  heartbeat: () => void;
  resume: () => void;
  suspend: () => void;
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

export function createMainWatchdogRuntime(): MainWatchdogRuntime {
  let activePostMessage: PostMainWatchdogMessage | null = null;

  const requirePostMessage = (): PostMainWatchdogMessage => {
    if (activePostMessage === null) {
      throw new Error('Main watchdog runtime is not attached');
    }
    return activePostMessage;
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

  const configureLogging = (fileLogging: MainWatchdogFileLoggingState): void => {
    const postMessage = requirePostMessage();
    postMessage({ logPath: resolveLogPath(fileLogging), type: 'config' });
  };

  const detach = (): void => {
    requirePostMessage();
    activePostMessage = null;
  };

  const postLifecycleMessage = (type: 'heartbeat' | 'resume' | 'suspend'): void => {
    requirePostMessage()({ type });
  };

  return {
    attach,
    configureLogging,
    detach,
    heartbeat: () => postLifecycleMessage('heartbeat'),
    resume: () => postLifecycleMessage('resume'),
    suspend: () => postLifecycleMessage('suspend'),
  };
}
