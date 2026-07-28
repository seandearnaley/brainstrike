import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import pino from 'pino';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../../scripts/build-main-config.mjs';

const [directory] = process.argv.slice(2);
if (!directory) {
  throw new Error('run-main-log-transport-worker: directory argument is required');
}

const outputDirectory = path.join(directory, 'dist');
const destination = path.join(directory, 'brainstrike.log');
await build({
  ...MAIN_PROCESS_BUILD_OPTIONS,
  entryPoints: {
    'main-log-transport': 'src/diagnostics/main-log-transport.ts',
  },
  logLevel: 'silent',
  outdir: outputDirectory,
});

const transport = pino.transport({
  targets: [
    {
      level: 'info',
      options: {
        destination,
        maxBytes: 320,
        maxFiles: 3,
      },
      target: path.join(outputDirectory, 'main-log-transport.js'),
    },
  ],
});
const finished = new Promise((resolve, reject) => {
  transport.once('finish', resolve);
  transport.once('error', reject);
});
const logger = pino({ base: undefined, timestamp: false }, transport);
for (let index = 0; index < 30; index += 1) {
  logger.info({ index }, `worker record ${index}`);
}
transport.flushSync();
transport.end();
await finished;

const logFiles = (await fs.readdir(directory))
  .filter((name) => name.startsWith('brainstrike.log'))
  .sort();
const sizes = await Promise.all(
  logFiles.map(async (logFile) => (await fs.stat(path.join(directory, logFile))).size)
);
const liveContents = await fs.readFile(destination, 'utf8');
process.stdout.write(JSON.stringify({ liveContents, logFiles, sizes }));
