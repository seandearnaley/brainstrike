import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { here, prepare, verifyRuntime, verifyStateSource } from './prepare.mjs';
import { evaluate } from './statistics.mjs';

if (process.env.BRAINSTRIKE_M0_A1_QUALIFICATION !== '1') {
  throw new Error(
    'Explicit BRAINSTRIKE_M0_A1_QUALIFICATION=1 is required after heavy-slot allocation'
  );
}
const [stateEntryArg, outputArg] = process.argv.slice(2);
if (!(stateEntryArg && outputArg)) {
  throw new Error('Usage: qualification.mjs <state-src/index.ts> <output-directory>');
}
const stateEntry = verifyStateSource(stateEntryArg);
verifyRuntime(stateEntry);
const output = resolve(outputArg);
mkdirSync(output);
prepare();
const records = [];
const rawDisplay =
  /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
    // biome-ignore lint/style/useNamingConvention: S is the historical candidate schema key.
    S: [],
    // biome-ignore lint/style/useNamingConvention: P is the historical candidate schema key.
    P: [],
  };

let activeChild;
let interrupted;
const interrupt = (signal) => {
  interrupted = signal;
  activeChild?.kill('SIGKILL');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

function run(mode, candidate, raw, big) {
  if (interrupted) {
    throw new Error(`Qualification interrupted by ${interrupted}`);
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(here, 'run.mjs'),
        mode,
        candidate,
        stateEntry,
        raw,
        ...(big ? [big] : []),
      ],
      { cwd: here, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 300_000);
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      activeChild = undefined;
      clearTimeout(timer);
      writeFileSync(`${raw}.stdout`, stdout);
      writeFileSync(`${raw}.stderr`, stderr);
      if (code !== 0 || timedOut || interrupted) {
        reject(
          new Error(
            `Qualification child failed (${mode}/${candidate}): code=${code}, signal=${signal}, timedOut=${timedOut}, interrupted=${interrupted ?? false}; see ${raw}.stderr`
          )
        );
        return;
      }
      try {
        resolveResult(JSON.parse(readFileSync(raw, 'utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  for (let round = 0; round < 20; round++) {
    const order = round % 2 === 0 ? ['S', 'P'] : ['P', 'S'];
    for (const candidate of order) {
      const raw = join(output, `display-${candidate}-${round}.json`);
      const record = await run('display', candidate, raw);
      records.push({ round, ...record.out, raw });
      rawDisplay[candidate].push(...record.display);
      writeFileSync(join(output, 'progress.json'), JSON.stringify({ records }, null, 2));
      // biome-ignore lint/suspicious/noConsole: CLI result/progress output preserves the measured protocol.
      console.log(`display ${round} ${candidate}: p95=${record.out.displayLatencyMs.p95}`);
    }
  }
  const big = join(output, 'read-100MiB.bin');
  const fd = openSync(big, 'wx');
  try {
    const chunk = randomBytes(1024 * 1024);
    for (let i = 0; i < 100; i++) {
      let written = 0;
      while (written < chunk.length) {
        const count = writeSync(fd, chunk, written, chunk.length - written);
        if (count <= 0) {
          throw new Error('Contention file write made no progress');
        }
        written += count;
      }
    }
  } finally {
    closeSync(fd);
  }
  const ratios = [];
  for (let round = 0; round < 3; round++) {
    const raw = join(output, `contention-S-${round}.json`);
    const record = await run('contend', 'S', raw, big);
    ratios.push(record.out.ratioP95);
    records.push({ round, ...record.out, raw });
    writeFileSync(join(output, 'progress.json'), JSON.stringify({ records }, null, 2));
  }
  const control = await run('no-host', 'S', join(output, 'no-host-S.json'), big);
  const result =
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      ...evaluate(rawDisplay, ratios),
      noHostObservation: control.out,
      negativeControl:
        'Historical J implementation unavailable; CT-J-worker negative control was not ported',
      kernelTrace: 'Not repeated: this unit measures latency/contention only',
      records,
    };
  writeFileSync(join(output, 'qualification.json'), JSON.stringify(result, null, 2));
  if (!(result.display.pass && result.contention.pass)) {
    process.exitCode = 1;
  }
  // biome-ignore lint/suspicious/noConsole: CLI result/progress output preserves the measured protocol.
  console.log(JSON.stringify(result.display));
  // biome-ignore lint/suspicious/noConsole: CLI result/progress output preserves the measured protocol.
  console.log(JSON.stringify(result.contention));
} catch (error) {
  writeFileSync(join(output, 'failure.txt'), `${error.stack ?? error}\n`);
  throw error;
}

process.removeListener('SIGINT', interrupt);
process.removeListener('SIGTERM', interrupt);
