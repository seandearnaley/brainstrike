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
  await backend.initialize({ modelId: payload.modelId });
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
  error: unknown
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
      diagnostics: {
        kind: request.payload.kind,
        modelId: 'modelId' in request.payload ? request.payload.modelId : undefined,
        requestId: request.requestId,
        runtimeId,
      },
    })
  );
}

async function processLlmHostRequest(
  backend: LocalLlmBackend,
  request: LlmHostRequest,
  runtimeId: string,
  createAbortController: (requestId: string) => AbortController,
  clearAbortController: (requestId: string) => void
): Promise<void> {
  let stage = 'received-request';
  try {
    logRequestReceived(request, runtimeId);
    stage = 'initialize-backend';
    if (request.payload.kind === 'warmup') {
      await handleWarmupRequest(backend, request, runtimeId);
      return;
    }
    stage = 'generate-response';
    const abortController = createAbortController(request.requestId);
    try {
      await handleGenerateRequest(backend, request, runtimeId, abortController);
    } finally {
      clearAbortController(request.requestId);
    }
  } catch (error) {
    reportRequestError(request, runtimeId, stage, error);
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
      const request = assertLlmHostRequest(rawRequest);
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
