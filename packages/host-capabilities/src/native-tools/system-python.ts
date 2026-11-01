/**
 * The standalone CLI's Python (owner decision, 2026-11-01): the system Python 3
 * the person installed, where Desktop runs its bundled CPython. Each launch
 * names an interpreter path, so this asks the candidate itself for
 * `sys.executable`: the Windows `py` launcher answers with the install it
 * selects, and a `python` that is Python 2 or a Store alias answers nothing
 * usable and is not chosen.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

/** Why one candidate did not answer: absent, not Python 3, or its own first error line. */
function probeFailure(error: unknown): string {
  // execFile's error carries the spawn errno, or the exit code, as `code`.
  const failure = error as Error & { code?: unknown; stderr?: unknown };
  if (failure.code === 'ENOENT') {
    return 'not found';
  }
  if (failure.code === 3) {
    return 'not Python 3';
  }
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  return stderr.split('\n', 1)[0] || failure.message;
}

/**
 * The absolute path of the system Python 3, asked of each candidate in order.
 * None answering is a visible, actionable refusal naming what was tried.
 */
async function probeSystemPython(): Promise<string> {
  const tried: string[] = [];
  for (const [command, ...args] of systemPythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(command, [...args, ...PROBE], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (stdout !== '') {
        return stdout;
      }
      tried.push(`${[command, ...args].join(' ')} (no interpreter path)`);
    } catch (error) {
      tried.push(`${[command, ...args].join(' ')} (${probeFailure(error)})`);
    }
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

/**
 * One host's system Python: the first call spawns the probe, and every later
 * run_python or skill-script call reuses its answer without spawning. A
 * refusal is not kept, so a Python installed afterwards is found by the next
 * call. Callers share one probe, which a caller's Stop leaves running for the
 * others.
 */
export function createSystemPythonResolver(): (signal?: AbortSignal) => Promise<string> {
  let resolved: Promise<string> | undefined;
  return async (signal) => {
    signal?.throwIfAborted();
    resolved ??= probeSystemPython().catch((error: unknown) => {
      resolved = undefined;
      throw error;
    });
    return await untilAborted(resolved, signal);
  };
}
