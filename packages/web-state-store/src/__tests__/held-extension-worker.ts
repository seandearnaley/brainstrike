/**
 * A writer worker composing an extension whose op holds until released: a
 * concurrent op, as the file index's are, beside the writer's own requests.
 */
import { startWebStateWorker } from '../web-state-writer';

let release: ((value: string) => void) | undefined;

startWebStateWorker([
  {
    id: 'held@1',
    open: () => ({
      close: () => undefined,
      concurrent: ['held.wait'],
      handlers: {
        'held.release': () => {
          release?.('released');
          return 'ok';
        },
        'held.wait': () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      },
    }),
  },
]);
