'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const {
  eventDeadlineMs,
  inbox,
  observerStartDeadlineMs,
  waitForObserverStart,
} = require('./command-job-fixture.cjs');

// The slowest observer start seen (BST-2213). In hosted Test run 39192445447 the
// first command-job observer had not pinned after 5 s, and its test's 55.7 s
// duration puts that start at roughly 40-50 s. That runner was never sampled.
const SLOWEST_SEEN_START_MS = 50_000;

// Stands in for a spawned process-observer.ps1: the fixture reads its stdout
// lines and its stderr, and watches for its exit.
function fakeObserver() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function track(promise) {
  const outcome = { settled: false };
  promise.then(
    (value) => Object.assign(outcome, { settled: true, value }),
    (error) => Object.assign(outcome, { error, settled: true })
  );
  return outcome;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const pinned = { event: 'pinned', identities: [{ pid: 7, start: '134368528585460229' }] };

test('an observer whose start takes as long as the slowest one seen is admitted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeObserver();
  const started = waitForObserverStart(inbox(child, true));
  t.mock.timers.tick(SLOWEST_SEEN_START_MS);
  child.stdout.write(`${JSON.stringify(pinned)}\r\n`);
  assert.deepEqual(await started, pinned);
});

test('an observer that never starts fails at the start deadline, not before, with its stderr', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeObserver();
  const observer = inbox(child, true);
  child.stderr.write('still starting\r\n');
  await flush();
  const started = track(waitForObserverStart(observer));
  t.mock.timers.tick(observerStartDeadlineMs - 1);
  await flush();
  assert.equal(started.settled, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(
    started.error.message,
    `Timed out after ${observerStartDeadlineMs} ms waiting for pinned: still starting\r\n`
  );
});

test('an observer that exits before it starts is reported at once, with its stderr', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeObserver();
  const observer = inbox(child, true);
  child.stderr.write('Add-Type : Cannot add type.\r\n');
  await flush();
  const started = track(waitForObserverStart(observer));
  child.exitCode = 1;
  child.emit('exit', 1, null);
  await flush();
  assert.equal(
    started.error.message,
    'Fixture exited before pinned: Add-Type : Cannot add type.\r\n'
  );
});

test('a started observer still answers each command within the event deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeObserver();
  const observer = inbox(child, true);
  const started = waitForObserverStart(observer);
  child.stdout.write(`${JSON.stringify(pinned)}\r\n`);
  await started;
  const checked = track(observer.wait('check'));
  t.mock.timers.tick(eventDeadlineMs - 1);
  await flush();
  assert.equal(checked.settled, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(checked.error.message, `Timed out after ${eventDeadlineMs} ms waiting for check: `);
});
