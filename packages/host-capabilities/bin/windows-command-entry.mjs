import { createRequire } from 'node:module';
import { runWindowsCommandWrapper } from '../src/windows-command-wrapper.ts';

const native = createRequire(import.meta.url)('@brainstrike/windows-job-native');
runWindowsCommandWrapper(() => native.getCurrentProcessIdentity());
