import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createTestFailureClassifier,
  runTestCommand,
  V8_WASM_JIT_FATAL_VERDICT,
} from '../run-test-command.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');

function integrationStepCommands(source) {
  const commands = [];
  for (const match of source.matchAll(
    /- name: (?:Pull request affected|Push and manual) integration tests[\s\S]*?\n\s+run: ([^\n]+)/gu
  )) {
    commands.push(match[1]?.trim());
  }
  return commands;
}

test('classifies the exact V8 WASM JIT teardown fatal across output chunks', () => {
  const classifier = createTestFailureClassifier();
  classifier.push(
    '# Fatal error in , line 0\n# Check failed: jit_page_->allocations_.erase(addr) == 1.\n'
  );
  classifier.push('2: V8_Fatal(char const*, ...)\n3: v8::internal::ThreadIsolation::');
  classifier.push('UnregisterWasmAllocation(unsigned long, unsigned long)\n');

  assert.equal(classifier.verdict(), V8_WASM_JIT_FATAL_VERDICT);
});

test('classifies an exact fatal when one output chunk exceeds the rolling window', () => {
  const classifier = createTestFailureClassifier();
  classifier.push(
    `${'prefix'.repeat(1000)}Check failed: jit_page_->allocations_.erase(addr) == 1.\nV8_Fatal\nThreadIsolation::UnregisterWasmAllocation`
  );

  assert.equal(classifier.verdict(), V8_WASM_JIT_FATAL_VERDICT);
});

test('does not combine markers from unrelated output regions', () => {
  const classifier = createTestFailureClassifier();
  classifier.push('Check failed: jit_page_->allocations_.erase(addr) == 1.');
  classifier.push('unrelated output'.repeat(500));
  classifier.push('V8_Fatal\nThreadIsolation::UnregisterWasmAllocation');

  assert.equal(classifier.verdict(), null);
});

test('does not classify an ordinary assertion failure or generic worker exit as the native fatal', () => {
  for (const output of [
    'AssertionError: expected 1 to equal 2',
    'Caused by: Error: Worker exited unexpectedly',
    'V8_Fatal without the WASM unregister assertion',
  ]) {
    const classifier = createTestFailureClassifier();
    classifier.push(output);
    assert.equal(classifier.verdict(), null);
  }
});

test('all required unit and integration steps run through the fatal classifier', () => {
  const commands = integrationStepCommands(workflow);
  for (const match of workflow.matchAll(
    /- name: (?:Pull request affected|Push and manual) unit tests[\s\S]*?\n\s+run: ([^\n]+)/gu
  )) {
    commands.push(match[1]?.trim());
  }
  assert.equal(commands.length, 4);
  for (const command of commands) {
    assert.match(
      command,
      /^node scripts\/run-test-command\.mjs -- pnpm turbo run test(?::integration)? /u
    );
  }
});

test('forwards termination signals to the child and removes signal listeners', async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };

  const run = runTestCommand(['node', 'run-test-command.mjs', '--', 'test-command'], {
    process: signalSource,
    spawn: () => child,
  });
  signalSource.emit('SIGTERM');
  child.emit('close', null, 'SIGTERM');

  assert.equal(await run, 1);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});

test('fails and annotates a classified fatal even when the child exits zero', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const stderr = new PassThrough();
  let stderrText = '';
  stderr.on('data', (chunk) => {
    stderrText += chunk.toString();
  });

  const run = runTestCommand(['node', 'run-test-command.mjs', '--', 'test-command'], {
    process: new EventEmitter(),
    spawn: () => child,
    stderr,
  });
  child.stdout.write(
    'Check failed: jit_page_->allocations_.erase(addr) == 1.\nV8_Fatal\nThreadIsolation::UnregisterWasmAllocation'
  );
  child.emit('close', 0, null);

  assert.equal(await run, 1);
  assert.match(stderrText, /BRAINSTRIKE_CI_VERDICT=V8_WASM_JIT_TEARDOWN_FATAL/u);
});

test('preserves a clean zero exit and forwards color intent for a TTY', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  let spawnOptions;

  const run = runTestCommand(['node', 'run-test-command.mjs', '--', 'test-command'], {
    env: {},
    process: new EventEmitter(),
    spawn: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
    stdout,
  });
  child.stdout.write('all tests passed');
  child.emit('close', 0, null);

  assert.equal(await run, 0);
  assert.equal(spawnOptions?.env.FORCE_COLOR, '1');
});
