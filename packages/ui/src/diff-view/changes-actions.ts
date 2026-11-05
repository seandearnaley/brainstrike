import type { ChangesAction } from '@brainstrike/types';

/** Every action, in the order its controls show, the one that moves work forward last. */
export const CHANGES_ACTIONS: readonly ChangesAction[] = ['revert', 'unstage', 'stage'];

export const CHANGES_ACTION_LABEL: Readonly<Record<ChangesAction, string>> = {
  revert: 'Revert',
  stage: 'Stage',
  unstage: 'Unstage',
};
