import type { run } from './measure';

export type StreamingPerfMeasurement = Awaited<ReturnType<typeof run>>;

declare global {
  interface Window {
    streamingPerfError?: string;
    streamingPerfMeasurement?: StreamingPerfMeasurement;
  }
}
