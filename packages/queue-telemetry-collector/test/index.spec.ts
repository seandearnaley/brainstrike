import { describe, expect, it } from 'vitest';
import { createQueueTelemetryCollector } from '../src/collector';
import { createQueueTelemetryCollector as createFromIndex } from '../src/index';

describe('index exports', () => {
  it('re-exports createQueueTelemetryCollector', () => {
    expect(createFromIndex).toBe(createQueueTelemetryCollector);
  });
});
