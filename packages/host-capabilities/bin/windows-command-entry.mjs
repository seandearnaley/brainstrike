import { createRequire } from 'node:module';
import { runWindowsCommandWrapper } from '../dist/windows-command-wrapper.js';

const native = createRequire(import.meta.url)('@brainstrike/windows-job-native');
runWindowsCommandWrapper(() => native.getCurrentProcessIdentity());
