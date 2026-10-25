// @vitest-environment node
// ADR-0030 decision 1: Main forks each index utility and lends the agent host a transferred port.
// The host's protocol must survive the hand-off, and an exit must mean the OS process is gone.
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { processStartTime } from '@brainstrike/state-store';
import { afterEach, expect, it } from 'vitest';
import { createHostUtilityLending } from '../agent-host-platform/host-lent-utility';
import { superviseUtility, type UtilitySupervision } from '../fork-utility';

/** A MessagePortMain end: what is posted to it waits until its owner starts it. */
class FakePort extends EventEmitter {
  peer: FakePort | undefined;
  closed = false;
  #queue: unknown[] | undefined = [];

  postMessage(data: unknown): void {
    this.peer?.deliver(data);
  }

  deliver(data: unknown): void {
    if (this.#queue) {
      this.#queue.push(data);
    } else {
      queueMicrotask(() => this.emit('message', { data }));
    }
  }

  start(): void {
    const queued = this.#queue ?? [];
    this.#queue = undefined;
    for (const data of queued) {
      this.deliver(data);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function channel(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

/** The forked utility as Electron reports it; `parent` is what it received on its parent port. */
function utility(pid?: number) {
  const parent: Array<{ readonly message: unknown; readonly ports: FakePort[] }> = [];
  const child = Object.assign(new EventEmitter(), {
    kill: () => true,
    kills: 0,
    parent,
    pid,
    postMessage: (message: unknown, ports: FakePort[]): void => {
      parent.push({ message, ports });
    },
  });
  child.kill = () => {
    child.kills += 1;
    return true;
  };
  return child;
}

const running: ChildProcess[] = [];
afterEach(() => {
  for (const standIn of running.splice(0)) {
    standIn.kill('SIGKILL');
  }
});

/** Main's side of the lending, for the utilities one host asked for. */
function mainLending() {
  const forks: Array<{ readonly kind: string; readonly utilityId: string }> = [];
  const kills: string[] = [];
  let refuse = false;
  const lending = createHostUtilityLending({
    fork: async (request) => {
      if (refuse) {
        throw new Error('Main is not ready');
      }
      forks.push({ kind: request.kind, utilityId: request.utilityId });
    },
    kill: async (utilityId) => {
      kills.push(utilityId);
    },
  });
  return {
    forks,
    kills,
    lending,
    refuseForks: () => {
      refuse = true;
    },
  };
}

function supervision() {
  const reports: unknown[] = [];
  const exited = Promise.withResolvers<{ readonly code: number }>();
  const supervised: UtilitySupervision = {
    errored: (type) => reports.push({ errored: type }),
    exited: (code) => {
      reports.push({ exited: code });
      exited.resolve({ code });
    },
    spawned: (pid) => reports.push({ spawned: pid }),
  };
  return { exited: exited.promise, reports, supervised };
}

it('delivers what the host posted before the channel arrived, over the channel the utility took', async () => {
  const main = mainLending();
  const lent = main.lending.fork('indexer', {});
  const answers: unknown[] = [];
  lent.on('message', (message) => answers.push(message));
  lent.postMessage({ id: 1, op: 'open' });
  await expect.poll(() => main.forks).toHaveLength(1);
  const utilityId = main.forks[0]?.utilityId ?? '';

  // Main starts the utility on one end of a channel and transfers the other to the host.
  const child = utility(41);
  const { port1, port2 } = channel();
  const { supervised } = supervision();
  superviseUtility(child, port1, supervised);
  const [first] = child.parent;
  expect(first?.message).toEqual({ event: 'utility-port' });
  const childPort = first?.ports[0];
  const received: unknown[] = [];
  childPort?.on('message', (event: { readonly data: { readonly id: number } }) => {
    received.push(event.data);
    childPort.postMessage({ id: event.data.id, kind: 'ready' });
  });
  childPort?.start();
  main.lending.attachPort(utilityId, port2);
  main.lending.spawned(utilityId, 41);

  await expect.poll(() => answers).toEqual([{ id: 1, kind: 'ready' }]);
  expect(received).toEqual([{ id: 1, op: 'open' }]);
  expect(lent.pid).toBe(41);
});

it('reports the exit only once the utility process has left the OS', async () => {
  const standIn = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  running.push(standIn);
  await once(standIn, 'spawn');
  const pid = standIn.pid;
  if (pid === undefined) {
    throw new Error('The stand-in utility has no pid.');
  }
  const child = utility(pid);
  const { exited, supervised } = supervision();
  superviseUtility(child, channel().port1, supervised);
  child.emit('spawn');

  const joined = exited.then(({ code }) => ({ code, live: processStartTime(pid) !== null }));
  // Electron reports `exit` before the OS exit; here the process is still running.
  child.emit('exit', 0);

  await expect(joined).resolves.toEqual({ code: 0, live: false });
});

it("ends the host's channel and refuses a late one once Main reports the exit", async () => {
  const main = mainLending();
  const lent = main.lending.fork('index-query', {});
  await expect.poll(() => main.forks).toHaveLength(1);
  const utilityId = main.forks[0]?.utilityId ?? '';
  const { port2 } = channel();
  main.lending.attachPort(utilityId, port2);
  const exits: number[] = [];
  lent.on('exit', (code) => exits.push(code));

  main.lending.exited(utilityId, 0);
  // Ending what remains was Main's: a kill after the exit sends nothing.
  expect(lent.kill()).toBe(true);
  expect(main.kills).toEqual([]);
  expect(exits).toEqual([0]);
  expect(port2.closed).toBe(true);

  const late = channel().port2;
  main.lending.attachPort(utilityId, late);
  expect(late.closed).toBe(true);
});

it('reports an exit for a utility Main could not start', async () => {
  const main = mainLending();
  main.refuseForks();
  const lent = main.lending.fork('index-coverage', {});
  const exited = new Promise<number>((resolve) => {
    lent.once('exit', resolve);
  });
  await expect(exited).resolves.toBe(1);
});
