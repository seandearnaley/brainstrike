/**
 * The standalone CLI's Python (owner decision, 2026-11-01): the system Python 3
 * the person installed, where Desktop runs its bundled CPython. Each launch
 * names an interpreter path, so this asks the candidate itself for
 * `sys.executable`: the Windows `py` launcher answers with the install it
 * selects, and a `python` that is Python 2 or a Store alias answers nothing
 * usable and is not chosen.
 */
import { createLogger } from '@brainstrike/logging';
import { spawnNativeChild, terminateTree } from '@brainstrike/state-store/native-children';
import { retainLiveChildProcess } from './execute-command-tool.ts';

const logger = createLogger('SystemPython');

/**
 * Candidates in the platform's documented order. On Windows the `py` command
 * (the Python install manager's, or the legacy launcher's) selects an
 * installed Python 3; `python3` there is a compatibility alias python.org does
 * not recommend. Elsewhere `python3` is the canonical name.
 */
function systemPythonCandidates(): readonly (readonly [string, ...string[]])[] {
  return process.platform === 'win32' ? [['py', '-3'], ['python']] : [['python3'], ['python']];
}

/** `-I` keeps the probe from importing anything beside the host's working directory. */
const PROBE = [
  '-I',
  '-c',
  'import sys; sys.exit(3) if sys.version_info[0] != 3 else sys.stdout.write(sys.executable)',
];

/** No Python 3 on this machine; run_python reports its `python_*` code as `interpreter_unavailable`. */
export class SystemPythonUnavailableError extends Error {
  readonly code = 'python_not_found';
}

/** How one candidate answered: its exit code and output, or the spawn error. */
type CandidateOutcome =
  | { readonly code: number | null; readonly stderr: string; readonly stdout: string }
  | { readonly spawnError: NodeJS.ErrnoException };

/** Why one candidate did not answer: absent, not Python 3, or its own first error line. */
function probeFailure(outcome: CandidateOutcome): string {
  if ('spawnError' in outcome) {
    return outcome.spawnError.code === 'ENOENT' ? 'not found' : outcome.spawnError.message;
  }
  if (outcome.code === 3) {
    return 'not Python 3';
  }
  return outcome.stderr.trim().split('\n', 1)[0] || `exited with code ${String(outcome.code)}`;
}

/**
 * One candidate, started like every native child this host starts and held in
 * the host's child registry until it exits, so host close retires it. Aborting
 * `probe` ends its tree; host close aborts `probe` first, so no later
 * candidate starts.
 */
function askCandidate(
  command: string,
  args: readonly string[],
  probe: AbortController
): Promise<CandidateOutcome> {
  const { signal } = probe;
  signal.throwIfAborted();
  return new Promise<CandidateOutcome>((resolve, reject) => {
    const child = spawnNativeChild(command, [...args, ...PROBE], {
      stdio: 'pipe',
      windowsHide: true,
    });
    child.stdin.end();
    const closed = Promise.withResolvers<void>();
    const end = async (): Promise<void> => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        await terminateTree(child.pid);
      }
      await closed.promise;
    };
    const abort = (): void => {
      end().catch((error: unknown) => {
        logger.warn('The Python probe could not be ended', { command, error });
      });
    };
    const release = retainLiveChildProcess({
      retire: async () => {
        probe.abort(new Error('The host closed while it was looking for Python.'));
        await end();
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (outcome: CandidateOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      release();
      closed.resolve();
      if (signal.aborted) {
        reject(signal.reason);
      } else {
        resolve(outcome);
      }
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (spawnError) => settle({ spawnError }));
    child.on('close', (code) => settle({ code, stderr, stdout }));
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * The absolute path of the system Python 3, asked of each candidate in order.
 * None answering is a visible, actionable refusal naming what was tried.
 */
async function probeSystemPython(probe: AbortController): Promise<string> {
  const tried: string[] = [];
  for (const [command, ...args] of systemPythonCandidates()) {
    const outcome = await askCandidate(command, args, probe);
    if (!('spawnError' in outcome) && outcome.code === 0 && outcome.stdout !== '') {
      return outcome.stdout;
    }
    tried.push(`${[command, ...args].join(' ')} (${probeFailure(outcome)})`);
  }
  throw new SystemPythonUnavailableError(
    `No Python 3 interpreter was found on PATH; tried ${tried.join(', ')}. ${
      process.platform === 'win32'
        ? 'Install Python 3 from python.org, which provides the `py` command,'
        : 'Install Python 3 so `python3` is on the host’s PATH,'
    } then retry.`
  );
}

/** The shared answer, or the caller's own Stop or deadline, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return work;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One probe in flight and the calls waiting on it. */
interface PendingProbe {
  readonly controller: AbortController;
  readonly path: Promise<string>;
  waiters: number;
}

/**
 * One host's system Python: the first call spawns the probe, and every later
 * run_python or skill-script call reuses its answer without spawning. Calls
 * waiting together share one probe, which runs while any of them waits: a
 * probe that hangs stays a running tool call the person can Stop. When the
 * last waiting call stops, the probe's process is ended and the next call
 * starts a fresh one. A refusal is not kept, so a Python installed afterwards
 * is found by the next call. Host close ends a probe in flight with the
 * host's other children (`disposeHostTools`).
 */
export function createSystemPythonResolver(): (signal?: AbortSignal) => Promise<string> {
  let resolved: string | undefined;
  let pending: PendingProbe | undefined;
  return async (signal) => {
    signal?.throwIfAborted();
    if (resolved !== undefined) {
      return resolved;
    }
    let probe = pending;
    if (!probe) {
      const controller = new AbortController();
      const started: PendingProbe = { controller, path: probeSystemPython(controller), waiters: 0 };
      started.path
        .then(
          (path) => {
            resolved = path;
          },
          () => undefined
        )
        .finally(() => {
          if (pending === started) {
            pending = undefined;
          }
        });
      pending = started;
      probe = started;
    }
    probe.waiters += 1;
    try {
      return await untilAborted(probe.path, signal);
    } finally {
      probe.waiters -= 1;
      if (probe.waiters === 0 && signal?.aborted) {
        if (pending === probe) {
          pending = undefined;
        }
        probe.controller.abort(signal.reason);
      }
    }
  };
}
