import { INTERNAL_FAULT, refusalError } from '@brainstrike/assistant-contract';

export const commandBoundaryCases = [
  {
    cause: refusalError(
      'conflict',
      'workspace.folder-removed',
      'The folder was removed.',
      'Add it again in Settings.'
    ),
    visible: 'The folder was removed. Add it again in Settings.',
  },
  {
    cause: new Error('ENOENT /Users/fixture/private/folder'),
    visible: INTERNAL_FAULT.message,
  },
].map(({ cause, visible }) => ({ onNew: () => Promise.reject(cause), visible }));
