#!/usr/bin/env node

// Executable spec of the Night Shift checkpoint grammar (PROTOCOL.md "Identity
// & state"). Loops MUST run this over a composed checkpoint line before
// posting it to their state issue; a non-zero exit means do not post.

const SCRIPT_NAME = 'validate-checkpoint';
const MESSAGE_MAX_CHARS = 300;
const STATUSES = ['NOOP', 'PR', 'READY', 'INCOMPLETE', 'BLOCKED'];
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const WATERMARK_PATTERN = /^(?:none|sha:[0-9a-f]{40}|hash:[0-9a-f]{64})$/u;
const LINE_PATTERN = /^(\S+) \| watermark=(\S+) \| status=(\S+) \| (.*)$/u;

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 1) {
  fail('expected exactly one argument: the full checkpoint line, quoted');
}
const line = args[0];

if (/[\r\n]/u.test(line)) {
  fail('checkpoint must be a single line');
}

const match = LINE_PATTERN.exec(line);
if (!match) {
  fail(
    'checkpoint shape must be: <UTC-ISO> | watermark=<kind>:<value> | status=<STATUS> | <one line>'
  );
}
const [, timestamp, watermark, status, message] = match;

if (!TIMESTAMP_PATTERN.test(timestamp)) {
  fail(`timestamp must be second-precision UTC ISO ending in Z (got: ${timestamp})`);
}
const parsed = new Date(timestamp);
if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp.replace('Z', '.000Z')) {
  fail(`timestamp is not a real calendar instant: ${timestamp}`);
}

if (!WATERMARK_PATTERN.test(watermark)) {
  fail(
    `watermark must be none, sha:<40-hex> (MAIN-DIFF), or hash:<64-hex sha256 of the sorted watched set> (EXTERNAL-STATE); got: ${watermark}`
  );
}

if (!STATUSES.includes(status)) {
  fail(`status must be one of ${STATUSES.join('|')}; got: ${status}`);
}

if (message.trim().length === 0) {
  fail('message must be a non-empty one-line summary');
}
if (message.length > MESSAGE_MAX_CHARS) {
  fail(`message exceeds ${MESSAGE_MAX_CHARS} characters (${message.length})`);
}

process.stdout.write('valid\n');
