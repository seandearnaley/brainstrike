#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

const OUTPUT_WINDOW_SIZE = 4096;
const REQUIRED_FATAL_MARKERS = [
  'Check failed: jit_page_->allocations_.erase(addr) == 1.',
  'V8_Fatal',
  'ThreadIsolation::UnregisterWasmAllocation',
];

export const V8_WASM_JIT_FATAL_VERDICT = 'V8_WASM_JIT_TEARDOWN_FATAL';

export function createTestFailureClassifier() {
  let fatalDetected = false;
  let outputWindow = '';

  return {
    push(chunk) {
      const candidate = `${outputWindow}${chunk}`;
      fatalDetected ||= REQUIRED_FATAL_MARKERS.every((marker) => candidate.includes(marker));
      outputWindow = candidate.slice(-OUTPUT_WINDOW_SIZE);
    },
    verdict() {
      return fatalDetected ? V8_WASM_JIT_FATAL_VERDICT : null;
    },
  };
}

function formatFatalVerdict() {
  return [
    '',
    `BRAINSTRIKE_CI_VERDICT=${V8_WASM_JIT_FATAL_VERDICT}`,
    'Node/V8 aborted while unregistering a WASM JIT allocation. This is the upstream',
    'BST-1221 native teardown defect, not an assertion failure. The lane remains failed:',
    'record the occurrence and inspect the lost-file diagnostic; do not treat a rerun as',
    'resolution.',
    '',
  ].join('\n');
}

export async function runTestCommand(argv = process.argv, options = {}) {
  const separatorIndex = argv.indexOf('--');
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const spawnImpl = options.spawn ?? spawn;
  const processSource = options.process ?? process;
  const env = options.env ?? process.env;

  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    stderr.write('Usage: node scripts/run-test-command.mjs -- <command> [args...]\n');
    return 1;
  }

  const command = argv[separatorIndex + 1];
  if (!command) {
    stderr.write('run-test-command: missing command after --\n');
    return 1;
  }

  const invocation = createSpawnInvocation(command, argv.slice(separatorIndex + 2));
  const classifier = createTestFailureClassifier();

  return await new Promise((resolve) => {
    const child = spawnImpl(invocation.command, invocation.args, {
      env: stdout.isTTY && env.FORCE_COLOR === undefined ? { ...env, FORCE_COLOR: '1' } : env,
      shell: invocation.shell,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let settled = false;
    const forwardSigint = () => child.kill('SIGINT');
    const forwardSigterm = () => child.kill('SIGTERM');
    const removeSignalListeners = () => {
      processSource.removeListener('SIGINT', forwardSigint);
      processSource.removeListener('SIGTERM', forwardSigterm);
    };
    processSource.on('SIGINT', forwardSigint);
    processSource.on('SIGTERM', forwardSigterm);

    const finish = (status) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalListeners();
      if (classifier.verdict() === V8_WASM_JIT_FATAL_VERDICT) {
        stderr.write(formatFatalVerdict());
        resolve(status === 0 ? 1 : status);
        return;
      }
      resolve(status);
    };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      classifier.push(text);
      stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      classifier.push(text);
      stderr.write(chunk);
    });
    child.on('error', (error) => {
      stderr.write(`run-test-command: failed to start ${command}: ${error.message}\n`);
      finish(1);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        stderr.write(`run-test-command: ${command} terminated by ${signal}\n`);
      }
      finish(code ?? 1);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runTestCommand();
}
