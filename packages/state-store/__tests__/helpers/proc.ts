import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export interface Proc {
  readonly exit: () => Promise<number | null>;
  /** The first stdout line starting with `needle` (rejects after `ms`). */
  readonly line: (needle: string, ms?: number) => Promise<string>;
  readonly out: () => string;
  readonly p: ChildProcess;
}

const kids: ChildProcess[] = [];

/** Kill every child a test left running. */
export function killKids(): void {
  for (const k of kids.splice(0)) {
    if (k.exitCode === null && k.signalCode === null) {
      k.kill('SIGKILL');
    }
  }
}

/** A Node child process; `.ts` scripts run with `--import tsx` from the package root, one process, no wrapper. */
export function run(args: readonly string[]): Proc {
  const p = spawn(process.execPath, [...args], {
    cwd: PACKAGE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  kids.push(p);
  let out = '';
  p.stdout.on('data', (d: Buffer) => {
    out += d.toString();
  });
  p.stderr.on('data', (d: Buffer) => process.stderr.write(`[child-err] ${d.toString()}`));
  return {
    exit: () =>
      new Promise<number | null>((res) => {
        if (p.exitCode !== null || p.signalCode !== null) {
          res(p.exitCode);
        } else {
          p.once('exit', (c) => res(c));
        }
      }),
    line: (needle, ms = 30_000) =>
      new Promise<string>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`no ${needle} in ${ms} ms: ${out}`)), ms);
        const check = (): boolean => {
          const l = out.split('\n').find((x) => x.startsWith(needle));
          if (l) {
            clearTimeout(t);
            res(l);
            return true;
          }
          return false;
        };
        if (!check()) {
          p.stdout.on('data', check);
        }
      }),
    out: () => out,
    p,
  };
}

export const runTs = (script: string, args: readonly string[] = []): Proc =>
  run(['--import', 'tsx', script, ...args]);
