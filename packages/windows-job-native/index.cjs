'use strict';

const bindings = require('bindings');

const native = bindings({
  bindings: 'windows_job_native',
  ['module_root']: __dirname,
});

module.exports = {
  activeProcessCount: native.activeProcessCount,
  drainOtherProcesses: native.drainOtherProcesses,
  initialize: native.initialize,
  terminateOtherProcesses: native.terminateOtherProcesses,
};
