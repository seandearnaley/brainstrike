#!/usr/bin/env node

// Composes a Night Shift checkpoint line from typed fields, then validates it
// with validate-checkpoint.mjs before printing. Loops MUST compose through
// this script instead of hand-writing the line: the fleet's first scored week
// measured 38 of 88 Assay checkpoints malformed (Magnify 18/30, Watch 5/8) —
// a validator behind hand composition catches the error after the reasoning
// that produced it; a composer removes the error class entirely.
//
// Usage:
//   compose-checkpoint.mjs --watermark <none|sha:<40hex>|hash:<64hex>>
//     --status <NOOP|PR|READY|INCOMPLETE|BLOCKED> --message "<one line>"
//     [--timestamp <UTC-ISO seconds>] [--posted-this-run <UTC-ISO>]
//
// Prints the composed line to stdout on success (exit 0). Any grammar
// violation exits non-zero via the validator, with its diagnostic.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_NAME = 'compose-checkpoint';

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const options = { message: null, postedThisRun: null, status: null, timestamp: null, watermark: null };
const FLAGS = new Map([
  ['--message', 'message'],
  ['--posted-this-run', 'postedThisRun'],
  ['--status', 'status'],
  ['--timestamp', 'timestamp'],
  ['--watermark', 'watermark'],
]);
for (let index = 0; index < argv.length; index += 1) {
  const key = FLAGS.get(argv[index]);
  if (!key) {
    fail(`unknown argument: ${argv[index]}`);
  }
  if (options[key] !== null) {
    fail(`${argv[index]} may be passed at most once`);
  }
  const value = argv[index + 1];
  if (value === undefined || (value.startsWith('--') && FLAGS.has(value))) {
    fail(`${argv[index]} requires a value`);
  }
  options[key] = value;
  index += 1;
}
for (const required of ['watermark', 'status', 'message']) {
  if (options[required] === null) {
    fail(`--${required === 'postedThisRun' ? 'posted-this-run' : required} is required`);
  }
}
if (/[\n\r|]/.test(options.message)) {
  fail('message must be one line and must not contain "|"');
}

// Second-precision UTC now; the grammar rejects milliseconds.
const timestamp = options.timestamp ?? `${new Date().toISOString().slice(0, 19)}Z`;
const line = `${timestamp} | watermark=${options.watermark} | status=${options.status} | ${options.message}`;

const validator = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validate-checkpoint.mjs');
const validatorArgs = [validator, line];
if (options.postedThisRun !== null) {
  validatorArgs.push('--posted-this-run', options.postedThisRun);
}
const result = spawnSync(process.execPath, validatorArgs, { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
process.stdout.write(`${line}\n`);
