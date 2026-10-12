import type { MutableRefObject } from 'react';
import type {
  EmbeddingHostCommand,
  EmbeddingHostDocumentEmbeddingsCancel,
  EmbeddingHostDocumentEmbeddingsRequest,
  EmbeddingHostDocumentEmbeddingsResponseReport,
  EmbeddingHostQueryEmbeddingCancel,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from '../../embedding-host-shared';
import {
  createEmbeddingHostStatus,
  type EmbeddingHostStatusOptions,
} from './embedding-host-status';
import type { EmbeddingHostWebGpuFact } from './embedding-host-webgpu';

export function getEmbeddingHostBridge(): {
  onDocumentEmbeddingsCancel?: (
    callback: (notice: EmbeddingHostDocumentEmbeddingsCancel) => void
  ) => () => void;
  onDocumentEmbeddingsRequest?: (
    callback: (request: EmbeddingHostDocumentEmbeddingsRequest) => void
  ) => () => void;
  reportDocumentEmbeddingsResponse?: (
    response: EmbeddingHostDocumentEmbeddingsResponseReport
  ) => void;
  onCommand?: (callback: (command: EmbeddingHostCommand) => void) => () => void;
  onQueryEmbeddingCancel?: (
    callback: (notice: EmbeddingHostQueryEmbeddingCancel) => void
  ) => () => void;
  onQueryEmbeddingRequest?: (
    callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
  ) => () => void;
  reportQueryEmbeddingResponse?: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
  reportStatus?: (status: EmbeddingHostStatus) => void;
} | null {
  const hostWindow = window as Window & {
    embeddingHost?: {
      onDocumentEmbeddingsCancel?: (
        callback: (notice: EmbeddingHostDocumentEmbeddingsCancel) => void
      ) => () => void;
      onDocumentEmbeddingsRequest?: (
        callback: (request: EmbeddingHostDocumentEmbeddingsRequest) => void
      ) => () => void;
      reportDocumentEmbeddingsResponse?: (
        response: EmbeddingHostDocumentEmbeddingsResponseReport
      ) => void;
      onCommand?: (callback: (command: EmbeddingHostCommand) => void) => () => void;
      onQueryEmbeddingCancel?: (
        callback: (notice: EmbeddingHostQueryEmbeddingCancel) => void
      ) => () => void;
      onQueryEmbeddingRequest?: (
        callback: (request: EmbeddingHostQueryEmbeddingRequest) => void
      ) => () => void;
      reportQueryEmbeddingResponse?: (response: EmbeddingHostQueryEmbeddingResponseReport) => void;
      reportStatus?: (status: EmbeddingHostStatus) => void;
    };
  };
  return hostWindow.embeddingHost ?? null;
}

export function getPowerBridge(): {
  onPowerState?: (callback: (state: 'resume' | 'suspend') => void) => () => void;
} | null {
  const hostWindow = window as Window & {
    power?: {
      onPowerState?: (callback: (state: 'resume' | 'suspend') => void) => () => void;
    };
  };
  return hostWindow.power ?? null;
}

/** This host's WebGPU detection (BST-1993); every status report carries it once known. */
let webgpuFact: EmbeddingHostWebGpuFact = {};

/** Record the detection a host start just ran, replacing an earlier start's. */
export function recordEmbeddingHostWebGpu(fact: EmbeddingHostWebGpuFact): void {
  webgpuFact = fact;
}

function reportStatus(status: EmbeddingHostStatus): void {
  getEmbeddingHostBridge()?.reportStatus?.({ ...status, ...webgpuFact });
}

export function reportQueryEmbeddingResponse(
  response: EmbeddingHostQueryEmbeddingResponseReport
): void {
  getEmbeddingHostBridge()?.reportQueryEmbeddingResponse?.(response);
}

export function reportEmbeddingHostRuntimeStatus(
  runtimeIdRef: MutableRefObject<string>,
  state: EmbeddingHostStatus['state'],
  options?: EmbeddingHostStatusOptions
): void {
  reportStatus(createEmbeddingHostStatus(runtimeIdRef.current, state, options));
}

export function reportEmbeddingHostRuntimeStatusForRuntimeId(
  runtimeId: string,
  state: EmbeddingHostStatus['state'],
  options?: EmbeddingHostStatusOptions
): void {
  reportStatus(createEmbeddingHostStatus(runtimeId, state, options));
}

export function reportDocumentEmbeddingsResponse(
  response: EmbeddingHostDocumentEmbeddingsResponseReport
): void {
  const report = getEmbeddingHostBridge()?.reportDocumentEmbeddingsResponse;
  if (!report) {
    throw new Error('Document embeddings response capability is unavailable.');
  }
  report(response);
}
