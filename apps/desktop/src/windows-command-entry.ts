/** Trusted command launch gate. User work never inherits this process's private IPC. */
import { createRequire } from 'node:module';
import { runWindowsCommandWrapper } from '@brainstrike/host-capabilities/windows-command-wrapper';
import { resolveBundledSiblingPath } from './bundled-sibling-path';

const native = createRequire(
  resolveBundledSiblingPath('Windows command wrapper', 'windows-command-entry.js')
)('@brainstrike/windows-job-native') as {
  getCurrentProcessIdentity(): { readonly creationTime: string; readonly pid: number };
};

runWindowsCommandWrapper(() => native.getCurrentProcessIdentity());
