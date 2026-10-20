import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveBundledSiblingPath } from '../bundled-sibling-path';

/** PROOF ONLY: no listener, worker or filesystem access unless explicitly enabled. */
export async function startProofCpuProfile(role: 'desktop-main' | 'agent-host'): Promise<void> {
  if (process.env['BRAINSTRIKE_PROOF_CPU_PROFILE'] !== '1') {
    return;
  }
  const output = process.env['BRAINSTRIKE_PROOF_CPU_DIR'];
  if (!(output && path.isAbsolute(output))) {
    throw new Error('CPU proof requires an absolute BRAINSTRIKE_PROOF_CPU_DIR');
  }
  const requestedAt = Date.now();
  const directory = path.join(output, `${role}-${process.pid}-${requestedAt}`);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const sibling = resolveBundledSiblingPath('CPU proof worker', 'proof-cpu-profile-worker.js');
  const archive = path.dirname(path.dirname(sibling));
  const workerPath =
    path.basename(archive) === 'app.asar'
      ? path.join(path.dirname(archive), 'app.asar.unpacked', 'dist', path.basename(sibling))
      : sibling;
  const worker = new Worker(workerPath, {
    execArgv: [],
    workerData: {
      captureMs: 60_000,
      directory,
      identity: {
        pid: process.pid,
        ppid: process.ppid,
        requestedAt,
        role,
        timeOrigin: performance.timeOrigin,
        versions: process.versions,
      },
      samplingIntervalUs: 5000,
      segmentMs: 5000,
    },
  });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const failed = (cause: Error) => {
      writeFileSync(
        path.join(directory, 'failure.json'),
        JSON.stringify({ message: cause.message })
      );
      process.stderr.write(`[cpu-proof] ${role} ${process.pid}: ${cause.message}\n`);
      reject(cause);
    };
    worker.on('error', failed);
    worker.on('message', (message: unknown) => {
      if (!(message && typeof message === 'object' && 'event' in message)) {
        return;
      }
      if (message.event === 'ready') {
        ready = true;
        // The observer never extends the application's lifetime.
        worker.unref();
        resolve();
      } else if (message.event === 'checkpoint') {
        worker.postMessage({
          at: Date.now(),
          cpu: process.threadCpuUsage(),
          event: 'target-thread-cpu',
        });
      }
    });
    worker.once('exit', (code) => {
      if (!ready || code !== 0) {
        failed(new Error(`CPU proof worker exited ${code}, ready=${ready}`));
      }
    });
  });
}
