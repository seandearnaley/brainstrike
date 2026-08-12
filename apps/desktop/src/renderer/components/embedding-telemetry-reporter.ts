import {
  getEmbeddingTelemetrySnapshot,
  subscribeEmbeddingTelemetry,
} from '@brainstrike/embedding-worker';
import type { EmbeddingWorkerController } from '@brainstrike/embeddings/worker';
import type { MutableRefObject } from 'react';
import type { EmbeddingHostRuntimeMetadata } from '../../embedding-host-shared';

const EMBEDDING_TELEMETRY_REPORT_INTERVAL_MS = 250;

interface EmbeddingTelemetryReporterOptions {
  readonly controllerRef: MutableRefObject<EmbeddingWorkerController | null>;
  readonly embeddingRuntimeRef: MutableRefObject<EmbeddingHostRuntimeMetadata | null>;
  readonly isDisposed: () => boolean;
  readonly reportStatus: () => void;
}

export function startEmbeddingTelemetryReporter(
  options: EmbeddingTelemetryReporterOptions
): () => void {
  let reportTimeout: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = subscribeEmbeddingTelemetry(() => {
    if (!options.embeddingRuntimeRef.current || reportTimeout !== null) {
      return;
    }
    reportTimeout = setTimeout(() => {
      reportTimeout = null;
      const currentMetadata = options.embeddingRuntimeRef.current;
      if (options.isDisposed() || options.controllerRef.current === null || !currentMetadata) {
        return;
      }
      options.embeddingRuntimeRef.current = {
        ...currentMetadata,
        telemetry: getEmbeddingTelemetrySnapshot(),
      };
      options.reportStatus();
    }, EMBEDDING_TELEMETRY_REPORT_INTERVAL_MS);
  });

  return () => {
    try {
      unsubscribe();
    } finally {
      if (reportTimeout !== null) {
        clearTimeout(reportTimeout);
        reportTimeout = null;
      }
    }
  };
}
