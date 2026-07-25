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
const SUPERSEDES_PATTERN = /(?:^|\s)supersedes=(\S+)/gu;

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

// Second-precision UTC ISO AND a real calendar instant. Date.parse alone
// accepts 2026-02-30 by rolling it forward, which would let a checkpoint claim
// a day that never existed.
function assertUtcInstant(label, value) {
  if (!TIMESTAMP_PATTERN.test(value)) {
    fail(`${label} must be second-precision UTC ISO ending in Z (got: ${value})`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value.replace('Z', '.000Z')) {
    fail(`${label} is not a real calendar instant: ${value}`);
  }
  return parsed;
}

const argv = process.argv.slice(2);
const positional = [];
let postedThisRun = null;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--posted-this-run') {
    if (postedThisRun !== null) {
      fail('--posted-this-run may be passed at most once');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail('--posted-this-run requires a UTC-ISO value: the checkpoint this run already posted');
    }
    postedThisRun = value;
    index += 1;
    continue;
  }
  if (argument.startsWith('--')) {
    fail(`unsupported argument: ${argument}`);
  }
  positional.push(argument);
}
if (positional.length !== 1) {
  fail('expected exactly one argument: the full checkpoint line, quoted');
}
const line = positional[0];

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

const parsed = assertUtcInstant('timestamp', timestamp);

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

// Run boundaries (PROTOCOL.md). One run posts one checkpoint. A second line in
// the same run is a CORRECTION of a line that was wrong when posted, and says
// so with supersedes=<the exact timestamp it corrects>. A watched-set item that
// moved while the loop worked is not a correction — it is the next run's input.
const supersedesMatches = [...message.matchAll(SUPERSEDES_PATTERN)];
if (supersedesMatches.length > 1) {
  fail(`message carries more than one supersedes token (${supersedesMatches.length})`);
}
const supersedes = supersedesMatches[0]?.[1] ?? null;
if (supersedes !== null) {
  const supersededAt = assertUtcInstant('supersedes', supersedes);
  if (supersededAt.getTime() >= parsed.getTime()) {
    fail(
      `supersedes must name an earlier checkpoint than this line: ${supersedes} is not before ${timestamp}`
    );
  }
}

if (postedThisRun !== null) {
  assertUtcInstant('--posted-this-run', postedThisRun);
  if (supersedes === null) {
    fail(
      `this run already posted a checkpoint at ${postedThisRun}; a second line must correct it explicitly — add supersedes=${postedThisRun} to the message, or let the moved input be the next run's watched set`
    );
  }
  if (supersedes !== postedThisRun) {
    fail(
      `supersedes must name the checkpoint this run already posted (${postedThisRun}); got ${supersedes}`
    );
  }
}

process.stdout.write('valid\n');
