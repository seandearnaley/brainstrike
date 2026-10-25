import { createLogger } from '@brainstrike/logging';
import {
  app,
  type ForkOptions,
  MessageChannelMain,
  type MessagePortMain,
  type UtilityProcess,
  utilityProcess,
} from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { type LentUtilityKind, UTILITY_PORT_EVENT } from './lent-utility';
import { endExitedProcess, liveProcessIdentity, type ProcessIdentity } from './process-exit-join';

const logger = createLogger('ForkUtility');

/**
 * Every Electron utility Main starts (ADR-0030). Its stdout and stderr are piped and copied to
 * Main's own: an inherited stream reached nothing on Windows (no agent host line in any app
 * output log), and a utility's log is the only evidence of why it stalled.
 */
export function forkUtility(
  modulePath: string,
  args: readonly string[],
  options: Omit<ForkOptions, 'stdio'>
): UtilityProcess {
  const child = utilityProcess.fork(modulePath, [...args], { ...options, stdio: 'pipe' });
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  return child;
}

/** The forked process: Electron's `UtilityProcess` surface this supervision reads. */
export interface ForkedUtility<ChildPort> {
  kill(): boolean;
  on(
    event: 'error',
    listener: (type: 'FatalError', location: string, report: string) => void
  ): this;
  once(event: 'exit', listener: (code: number) => void): this;
  once(event: 'spawn', listener: () => void): this;
  readonly pid: number | undefined;
  postMessage(message: unknown, transfer: ChildPort[]): void;
}

/** What Main reports of a utility it supervises for its owner. */
export interface UtilitySupervision {
  errored(type: string, location: string, report: string): void;
  /** Only once the utility's OS exit has been joined (ADR-0030 decision 3). */
  exited(code: number): void;
  spawned(pid: number | undefined): void;
}

/**
 * Starts `child` on its channel and supervises it: `childPort` goes to the child in its first
 * parent-port message; the owner holds the channel's other end. The exit is reported after
 * `endExitedProcess` joined the OS exit by the identity read at `spawn`.
 */
export function superviseUtility<ChildPort>(
  child: ForkedUtility<ChildPort>,
  childPort: ChildPort,
  supervision: UtilitySupervision
): void {
  let identity: ProcessIdentity | undefined;
  child.once('spawn', () => {
    identity = liveProcessIdentity(child.pid);
    supervision.spawned(child.pid);
  });
  child.on('error', (type, location, report) => supervision.errored(type, location, report));
  child.once('exit', (code) => {
    void endExitedProcess(identity).then(
      () => supervision.exited(code),
      (cause: unknown) => {
        logger.error('Could not end a utility after its exit', { cause, pid: identity?.pid });
        supervision.exited(code);
      }
    );
  });
  child.postMessage({ event: UTILITY_PORT_EVENT }, [childPort]);
}

interface LentUtilityEntry {
  /** The bundled entry beside main.js (`scripts/build-main-config.mjs`). */
  readonly entry: string;
  readonly label: string;
  readonly serviceName: string;
}
const LENT_UTILITIES: Readonly<Record<LentUtilityKind, LentUtilityEntry>> = {
  'index-coverage': {
    entry: 'sqlite-query-host-entry.js',
    label: 'SQLite index coverage',
    serviceName: 'brainstrike-index-coverage',
  },
  'index-query': {
    entry: 'sqlite-query-host-entry.js',
    label: 'SQLite index query',
    serviceName: 'brainstrike-index-query',
  },
  indexer: {
    entry: 'indexer-host-entry.js',
    label: 'Indexer host',
    serviceName: 'brainstrike-indexer',
  },
};

/**
 * Main's fork of an index utility for its owner (ADR-0030 decision 1): Main spawns it, supervises
 * it and joins its exit; the owner speaks the utility's protocol over `ownerPort`, wherever it runs.
 */
export function forkIndexUtility(
  kind: LentUtilityKind,
  env: Readonly<Record<string, string>>,
  supervision: UtilitySupervision
): { readonly child: Pick<UtilityProcess, 'kill' | 'pid'>; readonly ownerPort: MessagePortMain } {
  const { entry, label, serviceName } = LENT_UTILITIES[kind];
  if (!app.isReady()) {
    throw new Error(`${label} utility process requires Electron app readiness.`);
  }
  const child = forkUtility(resolveBundledSiblingPath(label, entry), [], {
    env: { ...process.env, ...env },
    serviceName,
  });
  const channel = new MessageChannelMain();
  superviseUtility(child, channel.port1, supervision);
  return { child, ownerPort: channel.port2 };
}
