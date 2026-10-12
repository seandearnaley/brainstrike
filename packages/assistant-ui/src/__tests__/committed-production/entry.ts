import './instrumentation';
import type {} from './receipt';

void import('./measure')
  .then(({ run }) => run())
  .then((measurement) => {
    window.committedProductionMeasurement = measurement;
  })
  .catch((cause: unknown) => {
    window.committedProductionError =
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
  });
