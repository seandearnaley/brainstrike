import './instrumentation';
import type {} from './receipt';

void import('./measure')
  .then(({ run }) => run())
  .then((measurement) => {
    window.streamingPerfMeasurement = measurement;
  })
  .catch((cause: unknown) => {
    window.streamingPerfError =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  });
