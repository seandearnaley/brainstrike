// A store in its own process, driven by a named scenario (M0-A2 src/proc/host-proc.ts, minus the indexer process and
// the window). Used where a test needs a real separate writer process: crash points (SIGKILL) and lock holding.
//   crash-purge <root> <in-txn|after-truth>   seed 40 events (event 20 holds the secret, as a blob), then purge 20
//                                              and die at the crash point
//   hold <root> [host]                         open the root, print `holding`, close on stdin `close`
import { StateStore } from '../../src/state-store.js';
import { appendInputs, seedInputs } from '../helpers/testkit.js';
import { TruthIndexer } from '../helpers/truth-indexer.js';

const [scenario, root, arg] = process.argv.slice(2) as [string, string, string | undefined];
const T = 't1';
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function crashPurge(at: string): Promise<void> {
  const die = (): never => {
    process.kill(process.pid, 'SIGKILL');
    throw new Error('unreachable');
  };
  const store = await StateStore.open(root, {
    ...(at === 'in-txn' ? { crashTestHooks: { purgeInTxn: 'sigkill' } } : {}),
    hooks: at === 'after-truth' ? { purgeAfterTruth: die } : {},
    indexer: new TruthIndexer(root),
  });
  await appendInputs(store, T, seedInputs(40, 20));
  say('seeded');
  await store.purge(T, 20);
  say(`error crash point ${at} was not reached`);
}

async function hold(host: string | undefined): Promise<void> {
  const store = await StateStore.open(root, host ? { host } : {});
  say(`holding ${process.pid}`);
  process.stdin.on('data', (d) => {
    if (String(d).includes('close')) {
      void store.close().then(() => {
        say('closed');
        process.exit(0);
      });
    }
  });
}

if (scenario === 'crash-purge') {
  await crashPurge(String(arg));
} else if (scenario === 'hold') {
  await hold(arg);
} else {
  throw new Error(`store-proc: unknown scenario ${scenario}`);
}
