import type { MutableRefObject } from 'react';
import type {
  EmbeddingHostCommand,
  EmbeddingHostQueryEmbeddingCancel,
  EmbeddingHostQueryEmbeddingRequest,
  EmbeddingHostQueryEmbeddingResponseReport,
  EmbeddingHostStatus,
} from '../../embedding-host-shared';
import {
  createEmbeddingHostStatus,
  type EmbeddingHostStatusOptions,
} from './embedding-host-status';

export function getEmbeddingHostBridge(): {
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

function reportStatus(status: EmbeddingHostStatus): void {
  getEmbeddingHostBridge()?.reportStatus?.(status);
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
