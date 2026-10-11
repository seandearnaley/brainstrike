'use strict';

const bindings = require('bindings');

const native = bindings({
  bindings: 'windows_job_native',
  ['module_root']: __dirname,
});

module.exports = {
  activeProcessCount: native.activeProcessCount,
  createCommandJob: native.createCommandJob,
  drainOtherProcesses: native.drainOtherProcesses,
  getCurrentProcessIdentity: native.getCurrentProcessIdentity,
  getProcessCreationTime: native.getProcessCreationTime,
  initialize: native.initialize,
  observeLinuxProcess: native.observeLinuxProcess,
  terminateOtherProcesses: native.terminateOtherProcesses,
};
