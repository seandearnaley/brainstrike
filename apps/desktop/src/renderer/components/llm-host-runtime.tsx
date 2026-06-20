import { LocalLlmBackend, type LocalLlmGenerationResult } from '@brainstrike/agent/local-llm';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef } from 'react';
import {
  assertLlmHostRequest,
  createLlmHostErrorReport,
  createLlmHostProgressReport,
  createLlmHostResultReport,
  createStoppedLlmHostStatus,
  type LlmHostRequest,
  type LlmHostResponseReport,
  type LlmHostStatus,
} from '../../llm-host-shared';

const logger = createLogger('LlmHostRuntime');

function getLlmHostBridge(): {
  onRequest?: (callback: (request: LlmHostRequest) => void) => () => void;
  reportProgress?: (progress: LlmHostResponseReport) => void;
  reportResponse?: (response: LlmHostResponseReport) => void;
  reportStatus?: (status: LlmHostStatus) => void;
} | null {
  const hostWindow = window as Window & {
    llmHost?: {
      onRequest?: (callback: (request: LlmHostRequest) => void) => () => void;
      reportProgress?: (progress: LlmHostResponseReport) => void;
      reportResponse?: (response: LlmHostResponseReport) => void;
      reportStatus?: (status: LlmHostStatus) => void;
    };
  };
  return hostWindow.llmHost ?? null;
}

function reportStatus(status: LlmHostStatus): void {
  getLlmHostBridge()?.reportStatus?.(status);
}

function reportResponse(response: LlmHostResponseReport): void {
  getLlmHostBridge()?.reportResponse?.(response);
}

function reportProgress(progress: LlmHostResponseReport): void {
  getLlmHostBridge()?.reportProgress?.(progress);
}

function resolveLlmHostRuntimeId(): string {
  const runtimeId = new URLSearchParams(window.location.search).get('runtimeId');
  if (!(runtimeId && runtimeId.trim().length > 0)) {
    throw new Error('Llm host renderer requires a runtimeId query parameter.');
  }
  return runtimeId;
}

function createActiveStatus(runtimeId: string): LlmHostStatus {
  return {
    runtimeKind: 'llm-host',
    runtimeId,
    state: 'running',
    active: true,
    lastError: null,
  };
}

function createIdleStatus(runtimeId: string): LlmHostStatus {
  return {
    runtimeKind: 'llm-host',
    runtimeId,
    state: 'running',
    active: false,
    lastError: null,
  };
}

/**
 * Validate an incoming host request. A request that fails validation must NOT
 * vanish: report the error back (keyed to the raw envelope when readable) so
 * the caller's pending entry rejects immediately instead of waiting out its
 * multi-minute timeout, and log loudly for diagnosis.
 */
function parseLlmHostRequestOrReport(
  rawRequest: unknown,
  fallbackRuntimeId: string
): LlmHostRequest | null {
  try {
    return assertLlmHostRequest(rawRequest);
  } catch (error) {
    const envelope = rawRequest as { requestId?: unknown; runtimeId?: unknown } | null;
    const requestId = typeof envelope?.requestId === 'string' ? envelope.requestId : null;
    const envelopeRuntimeId =
      typeof envelope?.runtimeId === 'string' ? envelope.runtimeId : fallbackRuntimeId;
    logger.error('Llm host received an invalid request', {
      requestId,
      runtimeId: envelopeRuntimeId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (requestId) {
      reportResponse(
        createLlmHostErrorReport(
          {
            type: 'request',
            channel: 'llm',
            requestId,
            runtimeId: envelopeRuntimeId,
            payload: { kind: 'cancel', requestId },
          },
          error
        )
      );
    }
    return null;
  }
}

function logRequestReceived(request: LlmHostRequest, runtimeId: string): void {
  logger.info('Llm host request received', {
    requestId: request.requestId,
    runtimeId,
    kind: request.payload.kind,
    modelId: 'modelId' in request.payload ? request.payload.modelId : undefined,
    messageCount: request.payload.kind === 'generate' ? request.payload.messages.length : undefined,
    toolCount:
      request.payload.kind === 'generate'
        ? (request.payload.options?.tools?.length ?? 0)
        : undefined,
    thinkingEnabled:
      request.payload.kind === 'generate'
        ? (request.payload.options?.thinking?.enabled ?? true)
        : undefined,
  });
}

async function handleWarmupRequest(
  backend: LocalLlmBackend,
  request: LlmHostRequest,
  runtimeId: string
): Promise<void> {
  if (request.payload.kind !== 'warmup') {
    throw new Error('Llm host warmup handler received a non-warmup request.');
  }
  await backend.initialize({
    modelId: request.payload.modelId,
    onProgress: (progress) => {
      reportProgress(
        createLlmHostProgressReport(request, {
          clientRequestId:
            request.payload.kind === 'warmup' ? request.payload.clientRequestId : undefined,
          kind: 'loading',
          message: progress.message,
          progress: progress.progress,
          ...(progress.file ? { file: progress.file } : {}),
        })
      );
    },
  });
  logger.info('Llm host warmup completed', {
    requestId: request.requestId,
    runtimeId,
    modelId: request.payload.modelId,
  });
  reportResponse(createLlmHostResultReport(request, null));
}

async function handleGenerateRequest(
  backend: LocalLlmBackend,
  request: LlmHostRequest,
  runtimeId: string,
  abortController: AbortController
): Promise<void> {
  const payload = request.payload;
  if (payload.kind !== 'generate') {
    throw new Error('Llm host generate handler received a non-generate request.');
  }
  // Cold (or post-reset) generates reload the model here — report the load
  // so the renderer badge shows progress instead of a silent stall.
  await backend.initialize({
    modelId: payload.modelId,
    onProgress: (progress) => {
      reportProgress(
        createLlmHostProgressReport(request, {
          clientRequestId: payload.clientRequestId,
          kind: 'loading',
          message: progress.message,
          progress: progress.progress,
          ...(progress.file ? { file: progress.file } : {}),
        })
      );
    },
  });
  const result = (await backend.generate(payload.messages, {
    ...payload.options,
    signal: abortController.signal,
    stream: {
      onStageChange: (stage) => {
        reportProgress(
          createLlmHostProgressReport(request, {
            clientRequestId: payload.clientRequestId,
            kind: 'stage',
            message: stage,
          })
        );
      },
      onReasoningSnapshot: (reasoningText) => {
        reportProgress(
          createLlmHostProgressReport(request, {
            clientRequestId: payload.clientRequestId,
            kind: 'reasoning',
            reasoningText,
          })
        );
      },
      onTextSnapshot: (text) => {
        reportProgress(
          createLlmHostProgressReport(request, {
            clientRequestId: payload.clientRequestId,
            kind: 'text',
            text,
          })
        );
      },
    },
  })) as LocalLlmGenerationResult;
  logger.info('Llm host generation completed', {
    requestId: request.requestId,
    runtimeId,
    modelId: payload.modelId,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls?.length ?? 0,
    textLength: result.text.length,
  });
  reportResponse(createLlmHostResultReport(request, result));
}

function reportRequestError(
  request: LlmHostRequest,
  runtimeId: string,
  stage: string,
  error: unknown,
  engineReset = false
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Llm host request failed', {
    error: message,
    requestId: request.requestId,
    runtimeId,
    kind: request.payload.kind,
    modelId: 'modelId' in request.payload ? request.payload.modelId : undefined,
    stage,
    ...(error instanceof Error && typeof error.stack === 'string' ? { stack: error.stack } : {}),
  });
  reportResponse(
    createLlmHostErrorReport(request, error, {
      stage,
      ...(engineReset ? { engineReset: true } : {}),
      diagnostics: {
        kind: request.payload.kind,
        modelId: 'modelId' in request.payload ? request.payload.modelId : undefined,
        requestId: request.requestId,
        runtimeId,
      },
    })
  );
}

/**
 * Engine/GPU faults poison the WebGPU session: subsequent generations keep
 * failing until the engine is rebuilt. Cancellations and prompt/validation
 * errors do NOT warrant the (expensive) reset, so only high-signal GPU fault
 * substrings match — generic words like "device"/"buffer"/"session"/"tensor"
 * also appear in tokenizer/template/validation errors, and a false positive
 * throws away a warmed multi-GB model. ("gpu" also covers "webgpu".)
 *
 * GPU memory exhaustion (e.g. prefilling a prompt larger than the device can
 * hold) is the same kind of poisoning fault, but ONNX Runtime surfaces it
 * through several messages that contain NO "gpu" substring: an OrtRun
 * `SafeInt` integer overflow, a `std::bad_alloc`, etc. We match the specific
 * ORT/C++ tokens (`ortrun`/`bad_alloc`/`safeint`) — not the generic phrase
 * "integer overflow", which `safeint` already covers and which is the only
 * token here that could plausibly appear in a non-engine error. Those tokens
 * never appear in JS tokenizer/template/validation errors, so matching them is
 * safe and keeps a single overflowed tool turn from bricking local chat for
 * the rest of the session.
 */
const ENGINE_FAULT_PATTERN =
  /gpu|unaligned|adapter|out of memory|device lost|ortrun|bad_alloc|safeint/i;

function isEngineFault(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return ENGINE_FAULT_PATTERN.test(message);
}

/**
 * Dispose the poisoned engine so the next warmup/generate reinitializes a
 * clean WebGPU session (reload from the local artifact cache — no
 * re-download), and return an error that SAYS the reset happened so the
 * recovery is visible in the chat error block, never silent.
 */
async function recoverFromEngineFault(
  backend: LocalLlmBackend,
  request: LlmHostRequest,
  runtimeId: string,
  error: unknown,
  retried: boolean
): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Llm host engine fault — resetting the local model engine', {
    error: message,
    requestId: request.requestId,
    retried,
    runtimeId,
  });
  try {
    await backend.dispose();
  } catch (disposeError) {
    logger.error('Llm host engine reset failed after engine fault', {
      error: disposeError instanceof Error ? disposeError.message : String(disposeError),
      requestId: request.requestId,
      runtimeId,
    });
  }
  const notice = new Error(
    retried
      ? `${message} — the local model engine was reset and the generation automatically retried once; the retry failed too, so this prompt likely exceeds what this device's GPU can handle. The next message will reload the model.`
      : `${message} — the local model engine was reset; the next message will reload the model.`
  );
  if (error instanceof Error && typeof error.stack === 'string') {
    notice.stack = error.stack;
  }
  return notice;
}

/**
 * GPU faults usually come from accumulated WebGPU session state (they tend to
 * appear on a SECOND-or-later generation), so a fresh engine on the same
 * prompt typically succeeds. Reset and retry the generation ONCE — announced
 * via a stage progress report and logs, never silently. A fault that survives
 * the retry propagates to the caller for the visible reset-notice error path.
 */
async function retryGenerateOnceAfterEngineFault(
  backend: LocalLlmBackend,
  request: LlmHostRequest,
  runtimeId: string,
  abortController: AbortController,
  faultError: unknown
): Promise<void> {
  logger.warn('Llm host engine fault — resetting the engine and retrying the generation once', {
    error: faultError instanceof Error ? faultError.message : String(faultError),
    requestId: request.requestId,
    runtimeId,
  });
  reportProgress(
    createLlmHostProgressReport(request, {
      clientRequestId:
        request.payload.kind === 'generate' ? request.payload.clientRequestId : undefined,
      kind: 'stage',
      message: 'local engine fault — reloading the model and retrying',
    })
  );
  await backend.dispose();
  await handleGenerateRequest(backend, request, runtimeId, abortController);
}

async function processLlmHostRequest(
  backend: LocalLlmBackend,
  request: LlmHostRequest,
  runtimeId: string,
  createAbortController: (requestId: string) => AbortController,
  clearAbortController: (requestId: string) => void
): Promise<void> {
  let stage = 'received-request';
  let retriedAfterEngineFault = false;
  // Hoisted so the outer catch can also honor an abort (see the catch below).
  let abortController: AbortController | null = null;
  try {
    logRequestReceived(request, runtimeId);
    stage = 'initialize-backend';
    if (request.payload.kind === 'warmup') {
      await handleWarmupRequest(backend, request, runtimeId);
      return;
    }
    stage = 'generate-response';
    abortController = createAbortController(request.requestId);
    try {
      await handleGenerateRequest(backend, request, runtimeId, abortController);
    } catch (error) {
      if (!isEngineFault(error) || abortController.signal.aborted) {
        throw error;
      }
      retriedAfterEngineFault = true;
      await retryGenerateOnceAfterEngineFault(backend, request, runtimeId, abortController, error);
    } finally {
      clearAbortController(request.requestId);
    }
  } catch (error) {
    // A recoverable engine fault is one the renderer already disposed locally;
    // flag it so the main-process manager escalates to a host-window reset
    // (a fresh WebGPU device) — disposing the ORT session alone leaves the
    // wedged device behind (see LlmHostErrorDetails.engineReset). Aborts never
    // trigger recovery: a cancelled generation can surface as a non-AbortError
    // engine-fault-shaped GPU error (teardown racing the inference), and a
    // spurious window reset on a cancelled request would needlessly reject
    // other in-flight work — so re-check the abort flag here too.
    const recoverableEngineFault =
      stage === 'generate-response' && isEngineFault(error) && !abortController?.signal.aborted;
    const reportedError = recoverableEngineFault
      ? await recoverFromEngineFault(backend, request, runtimeId, error, retriedAfterEngineFault)
      : error;
    reportRequestError(request, runtimeId, stage, reportedError, recoverableEngineFault);
  }
}

export function LlmHostRuntime(): null {
  const runtimeIdRef = useRef<string>(resolveLlmHostRuntimeId());
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const activeRequestCountRef = useRef(0);

  // biome-ignore lint/plugin: Hidden renderer host lifecycle wires external IPC request handling.
  useEffect(() => {
    logger.info('Llm host runtime booted', {
      runtimeId: runtimeIdRef.current,
    });
    const backend = new LocalLlmBackend();
    reportStatus({
      ...createStoppedLlmHostStatus(runtimeIdRef.current),
      runtimeId: runtimeIdRef.current,
      state: 'running',
    });

    const beginActiveRequest = (): void => {
      activeRequestCountRef.current += 1;
      if (activeRequestCountRef.current === 1) {
        reportStatus(createActiveStatus(runtimeIdRef.current));
      }
    };

    const endActiveRequest = (): void => {
      activeRequestCountRef.current = Math.max(0, activeRequestCountRef.current - 1);
      if (activeRequestCountRef.current === 0) {
        reportStatus(createIdleStatus(runtimeIdRef.current));
      }
    };

    const unsubscribeRequest = getLlmHostBridge()?.onRequest?.((rawRequest: LlmHostRequest) => {
      const request = parseLlmHostRequestOrReport(rawRequest, runtimeIdRef.current);
      if (!request) {
        return;
      }
      if (request.payload.kind === 'cancel') {
        abortControllersRef.current.get(request.payload.requestId)?.abort();
        return;
      }
      beginActiveRequest();
      void processLlmHostRequest(
        backend,
        request,
        runtimeIdRef.current,
        (requestId) => {
          const controller = new AbortController();
          abortControllersRef.current.set(requestId, controller);
          return controller;
        },
        (requestId) => {
          abortControllersRef.current.delete(requestId);
        }
      ).finally(() => {
        endActiveRequest();
      });
    });

    return () => {
      unsubscribeRequest?.();
      for (const controller of abortControllersRef.current.values()) {
        controller.abort();
      }
      abortControllersRef.current.clear();
      void backend.dispose();
      logger.info('Llm host runtime stopped', {
        runtimeId: runtimeIdRef.current,
      });
      reportStatus(createStoppedLlmHostStatus(runtimeIdRef.current));
    };
  }, []);

  return null;
}
