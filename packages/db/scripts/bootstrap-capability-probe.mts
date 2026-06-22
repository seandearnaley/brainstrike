#!/usr/bin/env tsx

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  formatBootstrapCapabilityProbeReportAsMarkdown,
  runPgliteBootstrapCapabilityProbe,
} from '../src/bootstrap/bootstrap-capability-probe.js';

type ProbeFormat = 'json' | 'markdown';

interface ProbeCliOptions {
  readonly format: ProbeFormat;
  readonly out: string;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPgliteBootstrapCapabilityProbe();
  const body =
    options.format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatBootstrapCapabilityProbeReportAsMarkdown(report);

  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body, 'utf8');

  if (report.blockingIssues.length > 0) {
    console.error(
      `Bootstrap capability probe found ${report.blockingIssues.length} blocking issue(s).`
    );
    return 1;
  }

  console.log(`Bootstrap capability probe wrote ${options.format} report to ${outputPath}`);
  return 0;
}

function parseArgs(args: readonly string[]): ProbeCliOptions {
  let format: ProbeFormat = 'json';
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--':
        break;
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

  if (!out) {
    throw new Error('Missing required --out file path.');
  }

  return { format, out };
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
