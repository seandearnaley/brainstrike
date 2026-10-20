import { appendFileSync, closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { type Profiler, Session } from 'node:inspector';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

/** PROOF ONLY. Connects locally to this process's main isolate; opens no inspector port. */
const session = new Session();
const { captureMs, directory, identity, samplingIntervalUs, segmentMs } = workerData;
if (
  !(
    typeof directory === 'string' &&
    path.isAbsolute(directory) &&
    [captureMs, samplingIntervalUs, segmentMs].every(
      (value) => Number.isSafeInteger(value) && value > 0
    )
  )
) {
  throw new Error('CPU proof worker received invalid capture settings');
}
const eventsPath = path.join(directory, 'capture.jsonl');
const scripts = openSync(path.join(directory, 'scripts.jsonl'), 'wx', 0o600);
const observerCpu = process.threadCpuUsage();
let targetThreadCpu: unknown;
let scriptCount = 0;
let baselineScripts = true;
parentPort?.on('message', (message: unknown) => {
  if (
    message &&
    typeof message === 'object' &&
    'event' in message &&
    message.event === 'target-thread-cpu'
  ) {
    targetThreadCpu = message;
  }
});
function command(method: string, params: Record<string, unknown> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error) => (error ? reject(error) : resolve()));
  });
}
function stopProfile(): Promise<Profiler.Profile> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (error, result) =>
      error ? reject(error) : resolve(result.profile)
    );
  });
}
function record(value: Record<string, unknown>): void {
  appendFileSync(eventsPath, `${JSON.stringify({ at: Date.now(), ...value })}\n`, { mode: 0o600 });
}
session.on('Debugger.scriptParsed', ({ params }) => {
  scriptCount += 1;
  writeSync(
    scripts,
    `${JSON.stringify({
      at: Date.now(),
      baseline: baselineScripts,
      endLine: params.endLine,
      length: params.length,
      scriptId: params.scriptId,
      startLine: params.startLine,
      url: params.url,
    })}\n`
  );
});
async function capture(): Promise<void> {
  session.connectToMainThread();
  await command('Profiler.enable');
  await command('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
  await command('Profiler.start');
  const beganAt = Date.now();
  await command('Debugger.enable');
  baselineScripts = false;
  record({
    beganAt,
    captureMs,
    cpuTimeUnit: 'microseconds',
    event: 'started',
    identity,
    samplingIntervalUs,
    scriptCount,
    segmentMs,
    setupObserverCpu: process.threadCpuUsage(observerCpu),
  });
  parentPort?.postMessage({ event: 'ready' });
  const finishAt = beganAt + captureMs;
  let segment = 0;
  let segmentStartedAt = beganAt;
  while (Date.now() < finishAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(segmentMs, finishAt - Date.now())));
    const stopRequestedAt = Date.now();
    const profile = await stopProfile();
    const stoppedAt = Date.now();
    const finished = stoppedAt >= finishAt;
    if (!finished) {
      await command('Profiler.start');
    }
    const restartedAt = Date.now();
    const exportCpu = process.threadCpuUsage();
    const file = `${String(++segment).padStart(3, '0')}.cpuprofile`;
    writeFileSync(path.join(directory, file), JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
    record({
      event: 'segment',
      exportCpu: process.threadCpuUsage(exportCpu),
      file,
      observerCpu: process.threadCpuUsage(observerCpu),
      processCpu: process.cpuUsage(),
      profileEndUs: profile.endTime,
      profileStartUs: profile.startTime,
      restartedAt,
      samples: profile.samples?.length,
      scriptCount,
      segmentStartedAt,
      stoppedAt,
      stopRequestedAt,
      targetThreadCpu,
    });
    parentPort?.postMessage({ event: 'checkpoint' });
    segmentStartedAt = restartedAt;
    if (finished) {
      break;
    }
  }
  await command('Debugger.disable');
  await command('Profiler.disable');
  record({
    event: 'complete',
    observerCpu: process.threadCpuUsage(observerCpu),
    segments: segment,
  });
}
void capture()
  .catch((cause: unknown) => {
    process.exitCode = 1;
    const message = cause instanceof Error ? cause.message : String(cause);
    record({ event: 'failed', message });
    writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ message }));
    process.stderr.write(`[cpu-proof] failed: ${message}\n`);
  })
  .finally(() => {
    session.disconnect();
    closeSync(scripts);
    parentPort?.close();
  });
