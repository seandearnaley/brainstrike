'use strict';
// Test-only capture before a response lets the parent terminate its native reader.
// NODE_V8_COVERAGE normally flushes on exit; SIGKILL cannot run that exit hook.
const { takeCoverage } = require('node:v8');

if (process.argv[1] === process.env.BRAINSTRIKE_NATIVE_COVERAGE_ENTRY) {
  if (!(process.env.NODE_V8_COVERAGE && process.send)) {
    throw new Error('Native IPC coverage requires V8 collection and an IPC channel.');
  }
  const send = process.send.bind(process);
  process.send = (...args) => {
    takeCoverage();
    return send(...args);
  };
}
