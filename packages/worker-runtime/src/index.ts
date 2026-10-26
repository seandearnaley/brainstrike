export interface SerializedRuntimeError {
  readonly cause?: string;
  readonly code?: string;
  readonly message: string;
  readonly name: string;
}

export interface RuntimeFailureLatch {
  clear: () => void;
  getFailure: () => Error | null;
  isFailed: () => boolean;
  markFailed: (error: unknown) => Error;
  throwIfFailed: () => void;
}

export interface RuntimeMessageTransport {
  onMessage: (listener: (message: unknown) => void) => () => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}

export interface WorkerRuntimeClient {
  clearFailure: () => void;
  dispose: () => void;
  getFailure: () => Error | null;
  isFailed: () => boolean;
  isReady: () => boolean;
  markFailed: (error: unknown) => Error;
  markReady: () => void;
  resetReady: () => void;
  throwIfFailed: () => void;
  transport: RuntimeMessageTransport;
}

export interface WorkerRuntimeClientOptions {
  readonly createErrorFromEvent?: (event: ErrorEvent) => Error;
  readonly onFailure?: (error: Error) => void;
}

export function createTerminalRuntimeFailureLatch(): RuntimeFailureLatch {
  let failure: Error | null = null;

  return {
    clear: () => {
      failure = null;
    },
    getFailure: () => failure,
    isFailed: () => failure !== null,
    markFailed: (error: unknown) => {
      if (failure) {
        return failure;
      }
      failure = toRuntimeError(error);
      return failure;
    },
    throwIfFailed: () => {
      if (failure) {
        throw failure;
      }
    },
  };
}

export function deserializeRuntimeError(error: SerializedRuntimeError | unknown): Error {
  if (isSerializedRuntimeError(error)) {
    const restored = new Error(error.message);
    restored.name = error.name;
    if (error.code) {
      (restored as Error & { code?: string }).code = error.code;
    }
    if (error.cause) {
      (restored as Error & { cause?: string }).cause = error.cause;
    }
    return restored;
  }
  return toRuntimeError(error);
}

export function createWorkerTransport(worker: Worker): RuntimeMessageTransport {
  return {
    onMessage: (listener: (message: unknown) => void) => {
      const handleMessage = (event: MessageEvent<unknown>) => {
        listener(event.data);
      };
      worker.addEventListener('message', handleMessage);
      return () => {
        worker.removeEventListener('message', handleMessage);
      };
    },
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      if (transfer) {
        worker.postMessage(message, transfer);
        return;
      }
      worker.postMessage(message);
    },
  };
}

export function createWorkerRuntimeClient(
  worker: Worker,
  options: WorkerRuntimeClientOptions = {}
): WorkerRuntimeClient {
  const transport = createWorkerTransport(worker);
  const failureLatch = createTerminalRuntimeFailureLatch();
  let ready = false;

  const handleError = (event: ErrorEvent) => {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    ready = false;
    const failure = failureLatch.markFailed(
      options.createErrorFromEvent?.(event) ??
        new Error(
          event.message
            ? `Worker runtime error: ${event.message}`
            : 'Worker runtime error (missing ErrorEvent.message)'
        )
    );
    options.onFailure?.(failure);
  };

  worker.addEventListener('error', handleError);

  return {
    clearFailure: () => {
      failureLatch.clear();
    },
    dispose: () => {
      worker.removeEventListener('error', handleError);
    },
    getFailure: () => failureLatch.getFailure(),
    isFailed: () => failureLatch.isFailed(),
    isReady: () => ready && !failureLatch.isFailed(),
    markFailed: (error: unknown) => {
      ready = false;
      const failure = failureLatch.markFailed(error);
      options.onFailure?.(failure);
      return failure;
    },
    markReady: () => {
      ready = true;
    },
    resetReady: () => {
      ready = false;
    },
    throwIfFailed: () => {
      failureLatch.throwIfFailed();
    },
    transport,
  };
}

function isSerializedRuntimeError(value: unknown): value is SerializedRuntimeError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate['name'] === 'string' && typeof candidate['message'] === 'string';
}

function toRuntimeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (isSerializedRuntimeError(error)) {
    return deserializeRuntimeError(error);
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error(String(error));
}
