import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const ProcessIdentity = Schema.Struct({
  creationTime: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
});
const Command = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  executable: Schema.String,
  windowsVerbatimArguments: Schema.Boolean,
});
const Completion = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.Literals(Object.keys(constants.signals) as NodeJS.Signals[])),
  type: Schema.Literal('completed'),
});
const WrapperMessage = Schema.Union([
  Schema.Struct({ identity: ProcessIdentity, type: Schema.Literal('ready') }),
  Completion,
  Schema.Struct({ code: Schema.String, type: Schema.Literal('failed') }),
]);
const StartMessage = Schema.Struct({ command: Command, type: Schema.Literal('start') });

export const decodeWindowsCommandStart = makeThrowingDecoder(StartMessage, {
  onExcessProperty: 'error',
});
const decodeWrapperMessage = makeThrowingDecoder(WrapperMessage, { onExcessProperty: 'error' });
export type WindowsCommand = typeof Command.Type;
export interface WindowsCommandExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The native owner remains in the parent, including after its wrapper has died. */
export interface WindowsCommandJob {
  assign(identity: typeof ProcessIdentity.Type): void;
  close(): void;
  terminateAndWait(exitCode: number): Promise<void>;
}

/** Creation has no process effects: the caller retains this entry and its lease before start. */
export function createWindowsCommandProcess(options: {
  readonly command: WindowsCommand;
  readonly createJob: () => WindowsCommandJob;
  readonly onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
  readonly onSettled: () => void;
  readonly spawnWrapper: () => ChildProcess;
}): { start: () => Promise<WindowsCommandExit>; retire: () => Promise<void> } {
  const result = Promise.withResolvers<WindowsCommandExit>();
  // Pre-launch disposal may settle before start obtains this same observable result.
  result.promise.catch(() => {});
  const closed = Promise.withResolvers<void>();
  let child: ChildProcess | undefined;
  let job: WindowsCommandJob | undefined;
  let assigned = false;
  let launched = false;
  let started = false;
  let forced = false;
  let exited = false;
  let completion: WindowsCommandExit | undefined;
  let wrapperExit: WindowsCommandExit | undefined;
  let failure: unknown;
  let retirement: Promise<void> | undefined;

  const retire = (cause?: unknown): Promise<void> => {
    if (cause !== undefined && failure === undefined) {
      failure = cause;
    }
    if (retirement) {
      return retirement;
    }
    const joined = Promise.withResolvers<void>();
    retirement = joined.promise;
    // Internal callers observe failure through result; explicit disposal also awaits joined.
    retirement.catch(() => {});
    if (!started) {
      closed.resolve();
      failure ??= new Error('Windows command was disposed before execution.');
    }
    let physical: Promise<void>;
    try {
      if (child && !assigned && !exited && !child.kill('SIGKILL')) {
        throw new Error('The gated Windows command wrapper could not be terminated.');
      }
      physical = job?.terminateAndWait(1) ?? Promise.resolve();
    } catch (error) {
      joined.reject(error);
      result.reject(error);
      return retirement;
    }
    void Promise.all([physical, closed.promise]).then(
      () => {
        try {
          job?.close();
          options.onSettled();
          joined.resolve();
          if (failure !== undefined) {
            result.reject(failure);
            return;
          }
          const observed = completion ?? (forced ? wrapperExit : undefined);
          if (!observed) {
            result.reject(new Error('Windows command exited without a completion receipt.'));
            return;
          }
          result.resolve(observed);
        } catch (error) {
          joined.reject(error);
          result.reject(error);
        }
      },
      (error: unknown) => {
        // A failed native wait is not settlement. Keep the Job, registry entry and lease.
        joined.reject(error);
        result.reject(error);
      }
    );
    return retirement;
  };

  const onMessage = (input: unknown): void => {
    try {
      const message = decodeWrapperMessage(input);
      if (message.type === 'completed') {
        if (!launched || completion) {
          throw new Error('Unexpected Windows command completion receipt.');
        }
        completion = { exitCode: message.exitCode, signal: message.signal };
        void retire();
        return;
      }
      if (retirement) {
        return;
      }
      if (message.type === 'failed') {
        throw new Error(`Windows command wrapper failed (${message.code}).`);
      }
      if (!(child && job) || assigned || message.identity.pid !== child.pid) {
        throw new Error('Unexpected Windows command wrapper identity.');
      }
      job.assign(message.identity);
      assigned = true;
      if (retirement) {
        return;
      }
      // Native assignment is synchronous. There is no user work on the other side before START.
      launched = true;
      child.send({ command: options.command, type: 'start' }, (error) => {
        if (error) {
          void retire(error);
        }
      });
    } catch (error) {
      void retire(error);
    }
  };

  return {
    retire: () => {
      forced = true;
      return retire();
    },
    start: () => {
      if (retirement) {
        return result.promise;
      }
      if (started) {
        throw new Error('A retained Windows command cannot be started twice.');
      }
      started = true;
      try {
        job = options.createJob();
        child = options.spawnWrapper();
        child.stdout?.on('data', (chunk: Buffer) => options.onOutput('stdout', chunk));
        child.stderr?.on('data', (chunk: Buffer) => options.onOutput('stderr', chunk));
        child.on('message', onMessage);
        child.on('error', (error) => {
          if (child?.pid === undefined) {
            // Node's failed-spawn error plus close joins the no-process case.
            exited = true;
          }
          void retire(error);
        });
        child.on('exit', (exitCode, signal) => {
          exited = true;
          wrapperExit = { exitCode, signal };
          if (!retirement) {
            void retire(new Error('Windows command exited without a completion receipt.'));
          }
        });
        child.on('close', () => closed.resolve());
        child.on('disconnect', () => {
          if (!retirement) {
            void retire(new Error('Windows command private channel disconnected.'));
          }
        });
      } catch (error) {
        // No wrapper was admitted when creation/spawn throws synchronously.
        closed.resolve();
        void retire(error);
      }
      return result.promise;
    },
  };
}
