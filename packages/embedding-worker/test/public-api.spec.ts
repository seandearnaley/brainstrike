import { describe, expect, it } from 'vitest';
import * as embeddingWorker from '../src/index';
import { resetEmbeddingTelemetryForTests } from '../src/testing';

describe('@brainstrike/embedding-worker public API', () => {
  it('does not expose the telemetry reset as a production control', () => {
    expect(embeddingWorker).not.toHaveProperty('resetEmbeddingTelemetryForTests');
    expect(resetEmbeddingTelemetryForTests).toBeTypeOf('function');
  });
});
