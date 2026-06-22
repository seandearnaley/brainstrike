#!/usr/bin/env tsx

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  formatTursoCapabilitySpikeReportAsMarkdown,
  runTursoCapabilitySpike,
} from '../src/bootstrap/turso-capability-spike.js';

type ProbeFormat = 'json' | 'markdown';

interface ProbeCliOptions {
  readonly dbPath: string;
  readonly format: ProbeFormat;
  readonly out: string;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runTursoCapabilitySpike({
    dbPath: resolve(options.dbPath),
  });
  const body =
    options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatTursoCapabilitySpikeReportAsMarkdown(report);

  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, 'utf8');

  if (report.blockingIssues.length > 0) {
    console.error(
      `Turso capability spike found ${report.blockingIssues.length} blocking issue(s).`
    );
    return 1;
  }

  console.log(`Turso capability spike wrote ${options.format} report to ${outputPath}`);
  return 0;
}

function parseArgs(args: readonly string[]): ProbeCliOptions {
  let dbPath: string | null = null;
  let format: ProbeFormat = 'json';
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--':
        break;
      case '--db-path': {
        const value = args[index + 1];
        if (!value) {
          throw new Error('Expected --db-path to include a file path.');
        }
        dbPath = value;
        index += 1;
        break;
      }
      case '--format': {
        const value = args[index + 1];
        if (value !== 'json' && value !== 'markdown') {
          throw new Error('Expected --format to be "json" or "markdown".');
        }
        format = value;
        index += 1;
        break;
      }
      case '--out': {
        const value = args[index + 1];
        if (!value) {
          throw new Error('Expected --out to include a file path.');
        }
        out = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!dbPath) {
    throw new Error('Missing required --db-path file path.');
  }
  if (!out) {
    throw new Error('Missing required --out file path.');
  }

  return { dbPath, format, out };
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
